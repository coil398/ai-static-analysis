// Generic LSP JSON-RPC client over stdio
// Language-agnostic base client extracted from adapters/go/lsp-client.ts.

import { resolve } from "node:path";

// --- LSP types (subset) ---

export interface LspPosition {
  line: number; // 0-based
  character: number; // 0-based, UTF-16
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

export interface LspCallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
  detail?: string;
}

export interface LspCallHierarchyOutgoingCall {
  to: LspCallHierarchyItem;
  fromRanges: LspRange[];
}

export interface LspCallHierarchyIncomingCall {
  from: LspCallHierarchyItem;
  fromRanges: LspRange[];
}

// Symbol kind codes (LSP spec)
const SYMBOL_KIND_MAP: Record<number, string> = {
  2: "Module",
  5: "Struct", // Class
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Variable", // Constructor
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "Struct",
  22: "Struct",
  23: "Struct", // Struct
};

// --- Client ---

const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes per LSP request

/** Default LSP capabilities used when none are provided. */
const DEFAULT_CAPABILITIES = {
  textDocument: {
    documentSymbol: {
      hierarchicalDocumentSymbolSupport: true,
    },
    callHierarchy: {},
    implementation: {},
    references: {},
  },
};

export class LspClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pendingRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private buffer = Buffer.alloc(0);
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private readLoopPromise: Promise<void> | null = null;
  private repoRoot: string;
  private command: string[];
  private initCapabilities: object;
  private spawnEnv: Record<string, string> | undefined;
  private handleServerRequests: boolean;
  /** Callbacks invoked for server-to-client notifications (no id, has method). */
  private notificationHandlers: Array<(method: string, params: unknown) => void> = [];
  /** Set to true when a $/progress end notification has been received (workspace ready). */
  private progressEndReceived = false;

  constructor(
    command: string[],
    repoRoot: string,
    initCapabilities?: object,
    env?: Record<string, string>,
    options?: { handleServerRequests?: boolean },
  ) {
    this.command = command;
    this.repoRoot = resolve(repoRoot);
    this.initCapabilities = initCapabilities ?? DEFAULT_CAPABILITIES;
    this.spawnEnv = env;
    this.handleServerRequests = options?.handleServerRequests ?? false;
  }

  async ensureStarted(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.start();
    return this.initPromise;
  }

  private async start(): Promise<void> {
    const spawnOptions: Parameters<typeof Bun.spawn>[1] = {
      cwd: this.repoRoot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    };
    if (this.spawnEnv) {
      spawnOptions.env = { ...process.env, ...this.spawnEnv } as Record<string, string>;
    }
    this.proc = Bun.spawn(this.command, spawnOptions);

    // Start reading stdout (store promise for error detection)
    this.readLoopPromise = this.readLoop();

    // Initialize LSP
    await this.sendRequest("initialize", {
      processId: process.pid,
      rootUri: `file://${this.repoRoot}`,
      capabilities: this.initCapabilities,
    });

    // Send initialized notification
    this.sendNotification("initialized", {});
    this.initialized = true;
  }

  private async readLoop(): Promise<void> {
    if (!this.proc?.stdout) return;

    const reader = this.proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer = Buffer.concat([this.buffer, Buffer.from(value)]);
        this.processBuffer();
      }
    } catch {
      // Process exited or crashed
    } finally {
      // Reject all pending requests — LSP server is gone
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("LSP server process exited with pending requests"));
        this.pendingRequests.delete(id);
      }
    }
  }

  private processBuffer(): void {
    while (true) {
      // Look for Content-Length header
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const headerStr = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(headerStr);
      if (!match) {
        // Skip malformed header
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.length < bodyEnd) break; // Need more data

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyEnd);

      try {
        const msg = JSON.parse(body);
        if ("id" in msg) {
          if ("method" in msg) {
            // Server-to-client request (e.g. client/registerCapability)
            if (this.handleServerRequests) {
              this.sendMessage({ jsonrpc: "2.0", id: msg.id, result: null });
            }
          } else if (this.pendingRequests.has(msg.id)) {
            // Response to a pending client request
            const pending = this.pendingRequests.get(msg.id)!;
            clearTimeout(pending.timer);
            this.pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(`LSP error: ${msg.error.message}`));
            } else {
              pending.resolve(msg.result);
            }
          }
        } else if ("method" in msg) {
          // Track $/progress end for waitForWorkspaceReady
          if (msg.method === "$/progress") {
            const p = msg.params as Record<string, unknown> | null;
            const value = p?.["value"] as Record<string, unknown> | undefined;
            if (value?.["kind"] === "end") {
              this.progressEndReceived = true;
            }
          }
          // Server-to-client notification (no id) — invoke handlers
          for (const handler of this.notificationHandlers) {
            handler(msg.method as string, msg.params);
          }
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  private sendMessage(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin) throw new Error("LSP server not started");
    const json = JSON.stringify(msg);
    const bytes = Buffer.from(json, "utf-8");
    const header = `Content-Length: ${bytes.length}\r\n\r\n`;
    this.proc.stdin.write(header);
    this.proc.stdin.write(bytes);
  }

  private sendRequest(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const effectiveTimeout = timeoutMs ?? REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request timeout (${effectiveTimeout}ms): ${method}`));
      }, effectiveTimeout);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.sendMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  private sendNotification(method: string, params: unknown): void {
    this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  private fileUri(relPath: string): string {
    return `file://${resolve(this.repoRoot, relPath)}`;
  }

  // --- Public API ---

  async documentSymbols(relPath: string, timeoutMs?: number): Promise<LspDocumentSymbol[]> {
    await this.ensureStarted();
    const result = await this.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri: this.fileUri(relPath) },
    }, timeoutMs);
    return (result as LspDocumentSymbol[] | null) ?? [];
  }

  async prepareCallHierarchy(
    relPath: string,
    line: number,
    character: number,
  ): Promise<LspCallHierarchyItem[]> {
    await this.ensureStarted();
    const result = await this.sendRequest(
      "textDocument/prepareCallHierarchy",
      {
        textDocument: { uri: this.fileUri(relPath) },
        position: { line, character },
      },
    );
    return (result as LspCallHierarchyItem[] | null) ?? [];
  }

  async outgoingCalls(item: LspCallHierarchyItem): Promise<LspCallHierarchyOutgoingCall[]> {
    await this.ensureStarted();
    const result = await this.sendRequest("callHierarchy/outgoingCalls", { item });
    return (result as LspCallHierarchyOutgoingCall[] | null) ?? [];
  }

  async incomingCalls(item: LspCallHierarchyItem): Promise<LspCallHierarchyIncomingCall[]> {
    await this.ensureStarted();
    const result = await this.sendRequest("callHierarchy/incomingCalls", { item });
    return (result as LspCallHierarchyIncomingCall[] | null) ?? [];
  }

  async implementation(
    relPath: string,
    line: number,
    character: number,
  ): Promise<LspLocation[]> {
    await this.ensureStarted();
    const result = await this.sendRequest("textDocument/implementation", {
      textDocument: { uri: this.fileUri(relPath) },
      position: { line, character },
    });
    return (result as LspLocation[] | null) ?? [];
  }

  async references(
    relPath: string,
    line: number,
    character: number,
    includeDeclaration = false,
  ): Promise<LspLocation[]> {
    await this.ensureStarted();
    const result = await this.sendRequest("textDocument/references", {
      textDocument: { uri: this.fileUri(relPath) },
      position: { line, character },
      context: { includeDeclaration },
    });
    return (result as LspLocation[] | null) ?? [];
  }

  /**
   * Send textDocument/didOpen notification.
   * Required by most LSP servers (e.g. pyright, typescript-language-server) before
   * document-level requests like documentSymbol can return results.
   */
  async openDocument(relPath: string, languageId: string): Promise<void> {
    await this.ensureStarted();
    const absPath = resolve(this.repoRoot, relPath);
    const text = await Bun.file(absPath).text();
    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: this.fileUri(relPath),
        languageId,
        version: 1,
        text,
      },
    });
  }

  /** Send textDocument/didClose notification. */
  async closeDocument(relPath: string): Promise<void> {
    await this.ensureStarted();
    this.sendNotification("textDocument/didClose", {
      textDocument: { uri: this.fileUri(relPath) },
    });
  }

  /**
   * Register a callback for server-to-client notifications.
   * Returns a function to unregister the callback.
   */
  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.push(handler);
    return () => {
      const idx = this.notificationHandlers.indexOf(handler);
      if (idx >= 0) this.notificationHandlers.splice(idx, 1);
    };
  }

  /**
   * Wait until the LSP server sends a `$/progress` end notification,
   * indicating that workspace loading is complete. Times out after `timeoutMs`.
   * Useful for servers like csharp-ls that load the workspace asynchronously.
   */
  async waitForWorkspaceReady(timeoutMs = 30_000): Promise<void> {
    await this.ensureStarted();
    // If we already received the end notification (workspace is ready), return immediately
    if (this.progressEndReceived) return;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const unregister = this.onNotification((method, params) => {
        if (method === "$/progress") {
          const p = params as Record<string, unknown> | null;
          const value = p?.["value"] as Record<string, unknown> | undefined;
          if (value?.["kind"] === "end") {
            clearTimeout(timer);
            unregister();
            resolve();
          }
        }
      });
    });
  }

  async shutdown(): Promise<void> {
    if (!this.proc || !this.initialized) return;
    try {
      await this.sendRequest("shutdown", {});
      this.sendNotification("exit", {});
      // Give the LSP server a moment to process the exit notification before killing
      const exitPromise = this.proc.exited;
      const timeout = new Promise<void>((r) => setTimeout(r, 2000));
      await Promise.race([exitPromise, timeout]);
    } catch {
      // Ignore errors during shutdown
    }
    // Clean up any remaining pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("LSP client shut down"));
      this.pendingRequests.delete(id);
    }
    if (this.proc) {
      this.proc.kill();
    }
    this.proc = null;
    this.initialized = false;
    this.initPromise = null;
    this.readLoopPromise = null;
  }

  // --- Mapping helpers ---

  static symbolKindName(kind: number): string {
    return SYMBOL_KIND_MAP[kind] ?? "Unknown";
  }

  static uriToPath(uri: string): string {
    return decodeURIComponent(uri.replace(/^file:\/\//, ""));
  }
}

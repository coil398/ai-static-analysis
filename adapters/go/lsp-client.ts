// Minimal LSP JSON-RPC client for gopls over stdio
// Manages a single gopls server process per repoRoot.

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
  6: "Enum",
  7: "Interface",
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
  // Go-specific: gopls uses 12 for functions, 6 for methods
};

// --- Client ---

export class GoplsLspClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pendingRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = Buffer.alloc(0);
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = resolve(repoRoot);
  }

  async ensureStarted(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.start();
    return this.initPromise;
  }

  private async start(): Promise<void> {
    this.proc = Bun.spawn(["gopls", "serve"], {
      cwd: this.repoRoot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Start reading stdout
    this.readLoop();

    // Initialize LSP
    await this.sendRequest("initialize", {
      processId: process.pid,
      rootUri: `file://${this.repoRoot}`,
      capabilities: {
        textDocument: {
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
          callHierarchy: {},
          implementation: {},
          references: {},
        },
      },
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
      // Process exited
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
        if ("id" in msg && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`LSP error: ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  private sendMessage(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin) throw new Error("gopls not started");
    const json = JSON.stringify(msg);
    const bytes = Buffer.from(json, "utf-8");
    const header = `Content-Length: ${bytes.length}\r\n\r\n`;
    this.proc.stdin.write(header);
    this.proc.stdin.write(bytes);
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
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

  async documentSymbols(
    relPath: string,
  ): Promise<LspDocumentSymbol[]> {
    await this.ensureStarted();
    const result = await this.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri: this.fileUri(relPath) },
    });
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

  async outgoingCalls(
    item: LspCallHierarchyItem,
  ): Promise<LspCallHierarchyOutgoingCall[]> {
    await this.ensureStarted();
    const result = await this.sendRequest("callHierarchy/outgoingCalls", {
      item,
    });
    return (result as LspCallHierarchyOutgoingCall[] | null) ?? [];
  }

  async incomingCalls(
    item: LspCallHierarchyItem,
  ): Promise<LspCallHierarchyIncomingCall[]> {
    await this.ensureStarted();
    const result = await this.sendRequest("callHierarchy/incomingCalls", {
      item,
    });
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

  async shutdown(): Promise<void> {
    if (!this.proc || !this.initialized) return;
    try {
      await this.sendRequest("shutdown", {});
      this.sendNotification("exit", {});
    } catch {
      // Ignore errors during shutdown
    }
    this.proc.kill();
    this.proc = null;
    this.initialized = false;
    this.initPromise = null;
  }

  // --- Mapping helpers ---

  static symbolKindName(kind: number): string {
    return SYMBOL_KIND_MAP[kind] ?? "Unknown";
  }

  static uriToPath(uri: string): string {
    return uri.replace(/^file:\/\//, "");
  }
}

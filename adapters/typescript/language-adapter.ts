// TypeScriptLanguageAdapter — TS_SPEC.md

import { resolve, relative, dirname, basename } from "node:path";
import { readdir } from "node:fs/promises";
import type {
  LanguageAdapter,
  DetectResult,
  DoctorResult,
  BootstrapResult,
} from "../../core/adapter/types.ts";
import type {
  Unit,
  File,
  Dep,
  Symbol,
  Ref,
  TypeRelation,
  CallEdge,
  FactsDelta,
  Diagnostic,
} from "../../core/schema/types.ts";
import {
  exec,
  whichTool,
  hashFile,
  isGenerated,
  hashSig,
  collectFiles,
  detectCyclicDeps,
  LspClient,
} from "../shared/index.ts";
import type { LspDocumentSymbol } from "../shared/index.ts";

export class TypeScriptLanguageAdapter implements LanguageAdapter {
  readonly lang = "typescript";

  async detect(repoRoot: string): Promise<DetectResult> {
    const tsconfig = Bun.file(resolve(repoRoot, "tsconfig.json"));
    if (await tsconfig.exists()) {
      return { supported: true, confidence: 1.0 };
    }
    const pkg = Bun.file(resolve(repoRoot, "package.json"));
    if (await pkg.exists()) {
      try {
        const data = await pkg.json();
        const hasTsDep =
          data.devDependencies?.typescript ||
          data.dependencies?.typescript;
        if (hasTsDep) return { supported: true, confidence: 0.9 };
      } catch { /* ignore parse errors */ }
    }
    return { supported: false, confidence: 0 };
  }

  async doctor(): Promise<DoctorResult> {
    const missing: string[] = [];
    const notes: string[] = [];

    const nodePath = await whichTool("node");
    if (!nodePath) {
      missing.push("node");
    } else {
      const ver = await exec(["node", "--version"]);
      if (ver.exitCode === 0) notes.push(`node: ${ver.stdout}`);
    }

    // tsc is optional — we can degrade
    const tscPath = await whichTool("tsc");
    if (!tscPath) {
      // Check npx tsc
      const npxTsc = await exec(["npx", "--no-install", "tsc", "--version"]);
      if (npxTsc.exitCode === 0) {
        notes.push(`tsc (via npx): ${npxTsc.stdout}`);
      } else {
        notes.push("tsc not found (optional, needed for type checking)");
      }
    } else {
      const ver = await exec(["tsc", "--version"]);
      if (ver.exitCode === 0) notes.push(`tsc: ${ver.stdout}`);
    }

    const optionalTools = [
      { name: "typescript-language-server", purpose: "symbols/refs/call_edges/type_relations" },
      { name: "eslint", purpose: "linting" },
      { name: "prettier", purpose: "formatting" },
      { name: "biome", purpose: "linting and formatting" },
    ];

    for (const { name, purpose } of optionalTools) {
      if (!(await whichTool(name))) {
        notes.push(`${name} not found (optional, needed for ${purpose})`);
      } else {
        notes.push(`${name}: available`);
      }
    }

    return { ok: missing.length === 0, missing_tools: missing, notes };
  }

  async bootstrap(): Promise<BootstrapResult> {
    const installed: string[] = [];
    const failed: Array<{ tool: string; reason: string }> = [];
    const notes: string[] = [];

    const npmPath = await whichTool("npm");
    if (!npmPath) {
      return {
        installed: [],
        failed: [{ tool: "npm", reason: "npm not found. Install Node.js from https://nodejs.org/" }],
        notes: [],
      };
    }

    const tools = ["typescript", "eslint", "prettier", "typescript-language-server"];
    for (const tool of tools) {
      if (await whichTool(tool === "typescript" ? "tsc" : tool)) {
        notes.push(`${tool}: already installed`);
        continue;
      }
      const result = await exec(["npm", "install", "-g", tool]);
      if (result.exitCode === 0) {
        installed.push(tool);
      } else {
        failed.push({ tool, reason: result.stderr });
      }
    }

    return { installed, failed, notes };
  }

  async enumerateUnits(
    repoRoot: string,
    _profile: Record<string, string>,
  ): Promise<Unit[]> {
    // Find all tsconfig.json files as project units
    const tsconfigs = await this.findTsconfigs(repoRoot);
    if (tsconfigs.length === 0) {
      // Fallback: treat root package.json as single unit
      const pkg = Bun.file(resolve(repoRoot, "package.json"));
      if (await pkg.exists()) {
        try {
          const data = await pkg.json();
          return [{
            id: "unit:ts:.",
            kind: "ts_project",
            name: data.name ?? basename(repoRoot),
            path: ".",
            metadata: { repo_root: repoRoot },
          }];
        } catch { /* ignore */ }
      }
      return [];
    }

    return tsconfigs.map((configPath) => {
      const relDir = relative(repoRoot, dirname(configPath)) || ".";
      const name = relDir === "." ? basename(repoRoot) : basename(relDir);
      return {
        id: `unit:ts:${relDir}`,
        kind: "ts_project",
        name,
        path: relDir,
        metadata: {
          tsconfig: relative(repoRoot, configPath),
          repo_root: repoRoot,
        },
      };
    });
  }

  async indexUnits(
    units: Unit[],
    _profile: Record<string, string>,
  ): Promise<FactsDelta> {
    const repoRoot = units[0]?.metadata?.["repo_root"] as string | undefined;
    if (!repoRoot) {
      throw new Error("units must contain repo_root in metadata");
    }

    const files: File[] = [];
    const deps: Dep[] = [];
    const unitIds = new Set(units.map((u) => u.id));

    // Collect all TS file paths for LSP processing
    const allTsFiles: Array<{ absPath: string; relPath: string; unitId: string }> = [];

    for (const unit of units) {
      const unitDir = resolve(repoRoot, unit.path);
      const sourceFiles = await collectFiles(
        unitDir,
        [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"],
        repoRoot,
      );

      for (const relPath of sourceFiles) {
        const absPath = resolve(repoRoot, relPath);
        const [hash, generated] = await Promise.all([
          hashFile(absPath),
          isGenerated(absPath),
        ]);
        files.push({
          id: `file:${relPath}`,
          path: relPath,
          unit_id: unit.id,
          hash,
          generated,
        });

        // generated ファイルは LSP 解析対象から除外する
        if (!generated) {
          allTsFiles.push({ absPath, relPath, unitId: unit.id });
        }

        // Parse imports for deps
        const importedUnits = await this.parseImports(absPath, repoRoot, unitIds);
        for (const depUnitId of importedUnits) {
          if (depUnitId !== unit.id && !deps.some(
            (d) => d.from_unit_id === unit.id && d.to_unit_id === depUnitId,
          )) {
            deps.push({
              from_unit_id: unit.id,
              to_unit_id: depUnitId,
              kind: "import",
            });
          }
        }
      }
    }

    // --- typescript-language-server integration (degrade if unavailable) ---
    const hasTsServer = (await whichTool("typescript-language-server")) !== null;
    let symbols: Symbol[] = [];
    let refs: Ref[] = [];
    let typeRelations: TypeRelation[] = [];
    let callEdges: CallEdge[] = [];

    if (hasTsServer && allTsFiles.length > 0) {
      const client = new LspClient(["typescript-language-server", "--stdio"], repoRoot);
      try {
        const result = await this.indexWithTsServer(
          repoRoot,
          allTsFiles,
          unitIds,
          client,
        );
        symbols = result.symbols;
        refs = result.refs;
        typeRelations = result.typeRelations;
        callEdges = result.callEdges;
      } catch {
        // typescript-language-server crashed or exited — degrade gracefully with empty LSP results
      } finally {
        await client.shutdown();
      }
    }

    return {
      added: {
        units,
        files,
        deps,
        symbols,
        refs,
        type_relations: typeRelations,
        call_edges: callEdges,
      },
      removed: {},
    };
  }

  private async indexWithTsServer(
    repoRoot: string,
    tsFiles: Array<{ absPath: string; relPath: string; unitId: string }>,
    unitIds: Set<string>,
    client: LspClient,
  ): Promise<{
    symbols: Symbol[];
    refs: Ref[];
    typeRelations: TypeRelation[];
    callEdges: CallEdge[];
  }> {
    const symbols: Symbol[] = [];
    const callEdges: CallEdge[] = [];
    const typeRelations: TypeRelation[] = [];
    const refs: Ref[] = [];

    // Track symbols by their declaration position for ID lookup
    const symbolByPos = new Map<string, Symbol>(); // "relPath:line:col" → Symbol
    // Track class/interface symbols for implementation queries
    const classSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];
    const funcSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];

    // 1. Collect symbols from all files
    // typescript-language-server requires textDocument/didOpen before documentSymbol
    const openedFiles: string[] = [];
    for (const { relPath } of tsFiles) {
      const langId = relPath.endsWith(".tsx")
        ? "typescriptreact"
        : relPath.endsWith(".jsx")
          ? "javascriptreact"
          : relPath.endsWith(".js") || relPath.endsWith(".mjs") || relPath.endsWith(".cjs")
            ? "javascript"
            : "typescript";
      try {
        await client.openDocument(relPath, langId);
        openedFiles.push(relPath);
      } catch { /* ignore */ }
    }

    for (const { relPath, unitId, absPath } of tsFiles) {
      let fileContent = "";
      try {
        fileContent = await Bun.file(absPath).text();
      } catch { /* ignore */ }

      let lspSyms: LspDocumentSymbol[];
      try {
        lspSyms = await client.documentSymbols(relPath);
      } catch {
        continue;
      }

      for (const lspSym of lspSyms) {
        this.processDocSymbol(
          lspSym,
          relPath,
          unitId,
          fileContent,
          symbols,
          symbolByPos,
          classSymbols,
          funcSymbols,
        );
      }
    }

    // 2. Collect call edges from functions/methods/constructors
    for (const { symbol, relPath, line, col } of funcSymbols) {
      let items;
      try {
        items = await client.prepareCallHierarchy(relPath, line - 1, col - 1);
      } catch {
        continue;
      }
      if (items.length === 0) continue;

      const item = items[0]!;
      let outgoing;
      try {
        outgoing = await client.outgoingCalls(item);
      } catch {
        continue;
      }

      for (const call of outgoing) {
        const calleeAbsPath = LspClient.uriToPath(call.to.uri);
        const calleeRelPath = relative(repoRoot, calleeAbsPath);
        const calleeLine = call.to.selectionRange.start.line + 1;
        const calleeCol = call.to.selectionRange.start.character + 1;
        const calleeKey = `${calleeRelPath}:${calleeLine}:${calleeCol}`;
        const calleeSym = symbolByPos.get(calleeKey);
        if (!calleeSym) continue;

        // Only include edges within our repo units
        if (!unitIds.has(calleeSym.unit_id)) continue;

        const callerFileId = `file:${relPath}`;
        for (const fromRange of call.fromRanges) {
          const rangeLine = fromRange.start.line + 1;
          const rangeCol = fromRange.start.character + 1;

          callEdges.push({
            caller_id: symbol.id,
            callee_id: calleeSym.id,
            site: {
              file_id: callerFileId,
              position: { line: rangeLine, column: rangeCol },
            },
            dispatch: "static",
          });

          refs.push({
            from_symbol_id: symbol.id,
            to_symbol_id: calleeSym.id,
            site: {
              file_id: callerFileId,
              position: { line: rangeLine, column: rangeCol },
            },
            kind: "call",
            confidence: "certain",
          });
        }
      }
    }

    // 2b. Collect non-call references for types and fields
    const refTargetSymbols = [
      ...classSymbols,
      ...symbols
        .filter((s) =>
          s.kind === "variable" ||
          s.kind === "constant" ||
          s.kind === "property" ||
          s.kind === "field",
        )
        .map((s) => {
          const pos = s.decl.position;
          const relPath = s.decl.file_id.replace(/^file:/, "");
          return { symbol: s, relPath, line: pos.line, col: pos.column };
        }),
    ];

    // Build a set of call-ref keys to avoid duplicates
    const callRefKeys = new Set(
      refs.map(
        (r) => `${r.to_symbol_id}@${r.site.file_id}:${r.site.position.line}:${r.site.position.column}`,
      ),
    );

    for (const { symbol: targetSym, relPath: tRelPath, line: tLine, col: tCol } of refTargetSymbols) {
      let refLocs;
      try {
        refLocs = await client.references(tRelPath, tLine - 1, tCol - 1);
      } catch {
        continue;
      }

      for (const loc of refLocs) {
        const locAbsPath = LspClient.uriToPath(loc.uri);
        const locRelPath = relative(repoRoot, locAbsPath);
        const locLine = loc.range.start.line + 1;
        const locCol = loc.range.start.character + 1;

        // Skip the declaration itself
        if (locRelPath === tRelPath && locLine === tLine && locCol === tCol) continue;

        const fileId = `file:${locRelPath}`;

        // Skip if already covered by a call-derived ref
        const refKey = `${targetSym.id}@${fileId}:${locLine}:${locCol}`;
        if (callRefKeys.has(refKey)) continue;

        const fromSymbol = this.findEnclosingSymbol(symbols, fileId, locLine);

        const kind = targetSym.kind === "interface" || targetSym.kind === "class"
          ? "type_ref"
          : targetSym.kind === "field" || targetSym.kind === "property"
            ? "field_access"
            : "reference";

        refs.push({
          from_symbol_id: fromSymbol?.id ?? `file_scope:${locRelPath}`,
          to_symbol_id: targetSym.id,
          site: {
            file_id: fileId,
            position: { line: locLine, column: locCol },
          },
          kind,
          confidence: "certain",
        });
      }
    }

    // 3. Collect type relations (implementations) for class/interface symbols
    for (const { symbol, relPath, line, col } of classSymbols) {
      if (symbol.kind !== "interface" && symbol.kind !== "class") continue;

      let implLocs;
      try {
        implLocs = await client.implementation(relPath, line - 1, col - 1);
      } catch {
        continue;
      }

      for (const loc of implLocs) {
        const implAbsPath = LspClient.uriToPath(loc.uri);
        const implRelPath = relative(repoRoot, implAbsPath);
        const implLine = loc.range.start.line + 1;
        const implCol = loc.range.start.character + 1;
        const implKey = `${implRelPath}:${implLine}:${implCol}`;
        const implSym = symbolByPos.get(implKey);
        if (!implSym) continue;

        typeRelations.push({
          from_type_id: implSym.id,
          to_type_id: symbol.id,
          kind: "implements",
        });
      }
    }

    // Close all opened documents
    for (const relPath of openedFiles) {
      try {
        await client.closeDocument(relPath);
      } catch { /* ignore */ }
    }

    return { symbols, refs, typeRelations, callEdges };
  }

  /**
   * Recursively process a LspDocumentSymbol and its children into Symbol[].
   */
  private processDocSymbol(
    sym: LspDocumentSymbol,
    relPath: string,
    unitId: string,
    fileContent: string,
    symbols: Symbol[],
    symbolByPos: Map<string, Symbol>,
    classSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }>,
    funcSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }>,
    parentName?: string,
  ): void {
    const converted = this.lspSymbolToSymbol(sym, relPath, unitId, fileContent, parentName);
    symbols.push(converted);

    const line = sym.selectionRange.start.line + 1;
    const col = sym.selectionRange.start.character + 1;
    symbolByPos.set(`${relPath}:${line}:${col}`, converted);

    const kind = converted.kind;
    if (kind === "class" || kind === "interface") {
      classSymbols.push({ symbol: converted, relPath, line, col });
    }
    if (kind === "function" || kind === "method" || kind === "constructor") {
      funcSymbols.push({ symbol: converted, relPath, line, col });
    }

    for (const child of sym.children ?? []) {
      this.processDocSymbol(
        child,
        relPath,
        unitId,
        fileContent,
        symbols,
        symbolByPos,
        classSymbols,
        funcSymbols,
        sym.name,
      );
    }
  }

  private lspSymbolToSymbol(
    sym: LspDocumentSymbol,
    relPath: string,
    unitId: string,
    fileContent: string,
    parentName?: string,
  ): Symbol {
    const kind = this.mapLspSymbolKind(sym.kind);
    const line = sym.selectionRange.start.line + 1;
    const col = sym.selectionRange.start.character + 1;
    const sigHash = hashSig(`${sym.name}:${sym.kind}:${line}`);
    const unitPath = unitId.replace(/^unit:ts:/, "");

    return {
      id: `sym:ts:${unitPath}#${kind}#${sym.name}#sig:${sigHash}`,
      unit_id: unitId,
      name: sym.name,
      kind,
      exported: this.isExported(sym.name, fileContent),
      decl: {
        file_id: `file:${relPath}`,
        position: { line, column: col },
      },
      metadata: parentName ? { receiver: parentName } : undefined,
    };
  }

  private mapLspSymbolKind(kind: number): string {
    const map: Record<number, string> = {
      5: "class",
      6: "method",
      7: "property",
      8: "field",
      9: "constructor",
      10: "enum",
      11: "interface",
      12: "function",
      13: "variable",
      14: "constant",
      22: "enum_member",
      23: "struct",
    };
    return map[kind] ?? "unknown";
  }

  private isExported(name: string, fileContent: string): boolean {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // export function/class/interface/const/let/var/type/enum NAME
    const declRe = new RegExp(
      `export\\s+(?:default\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|const|let|var|type|enum)\\s+${escaped}\\b`,
    );
    if (declRe.test(fileContent)) return true;
    // export { NAME } or export { NAME as alias }
    const namedRe = new RegExp(`export\\s*\\{[^}]*\\b${escaped}\\b`);
    return namedRe.test(fileContent);
  }

  /**
   * Find the enclosing function/method/constructor symbol for a given file position.
   */
  private findEnclosingSymbol(
    symbols: Symbol[],
    fileId: string,
    line: number,
  ): Symbol | null {
    const fileFuncs = symbols
      .filter(
        (s) =>
          s.decl.file_id === fileId &&
          (s.kind === "function" || s.kind === "method" || s.kind === "constructor"),
      )
      .sort((a, b) => a.decl.position.line - b.decl.position.line);

    for (let i = 0; i < fileFuncs.length; i++) {
      const sym = fileFuncs[i]!;
      const nextStart =
        i + 1 < fileFuncs.length
          ? fileFuncs[i + 1]!.decl.position.line
          : Infinity;
      if (sym.decl.position.line <= line && line < nextStart) {
        return sym;
      }
    }
    return null;
  }

  async diagnose(
    units: Unit[],
    _profile: Record<string, string>,
  ): Promise<Diagnostic[]> {
    const repoRoot = units[0]?.metadata?.["repo_root"] as string | undefined;
    if (!repoRoot) return [];

    const diagnostics: Diagnostic[] = [];

    // 1. tsc --noEmit (type checking)
    const hasTsc = (await whichTool("tsc")) !== null;
    if (hasTsc) {
      const tscResult = await exec(
        ["tsc", "--noEmit", "--pretty", "false"],
        { cwd: repoRoot },
      );
      if (tscResult.exitCode !== 0) {
        diagnostics.push(...this.parseTscOutput(tscResult.stdout || tscResult.stderr, repoRoot));
      }
    } else {
      // Try npx
      const npxResult = await exec(
        ["npx", "--no-install", "tsc", "--noEmit", "--pretty", "false"],
        { cwd: repoRoot },
      );
      if (npxResult.exitCode !== 0 && (npxResult.stdout || npxResult.stderr)) {
        diagnostics.push(...this.parseTscOutput(npxResult.stdout || npxResult.stderr, repoRoot));
      }
    }

    // 2. eslint (optional)
    if (await whichTool("eslint")) {
      const eslintResult = await exec(
        ["eslint", "--format", "json", "."],
        { cwd: repoRoot },
      );
      if (eslintResult.stdout) {
        diagnostics.push(...this.parseEslintOutput(eslintResult.stdout, repoRoot));
      }
    }

    // 3. Circular dependency detection
    const allUnits = await this.enumerateUnits(repoRoot, _profile);
    const delta = await this.indexUnits(allUnits, _profile);
    if (delta.added.deps) {
      diagnostics.push(...detectCyclicDeps(delta.added.deps, "unit:ts:"));
    }

    return diagnostics;
  }

  // --- Private helpers ---

  private async findTsconfigs(repoRoot: string): Promise<string[]> {
    const results: string[] = [];
    const skipDirs = new Set([
      "node_modules", ".git", "dist", "build", "cache", "coverage",
    ]);

    async function walk(dir: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !skipDirs.has(entry.name)) {
          await walk(resolve(dir, entry.name));
        } else if (entry.name === "tsconfig.json") {
          results.push(resolve(dir, entry.name));
        }
      }
    }

    await walk(repoRoot);
    return results;
  }

  private async parseImports(
    filePath: string,
    repoRoot: string,
    unitIds: Set<string>,
  ): Promise<string[]> {
    const file = Bun.file(filePath);
    let content: string;
    try {
      content = await file.text();
    } catch {
      return [];
    }

    const importedUnits = new Set<string>();
    // Match: import ... from "..." / require("...") / import("...")
    const re = /(?:from\s+['"]|require\s*\(\s*['"]|import\s*\(\s*['"])([^'"]+)/g;
    let match;
    while ((match = re.exec(content)) !== null) {
      const spec = match[1]!;
      // Only local relative imports
      if (!spec.startsWith(".")) continue;
      const resolved = resolve(dirname(filePath), spec);
      const relDir = relative(repoRoot, dirname(resolved));
      // Walk up to find which unit this belongs to
      let current = relDir;
      while (current) {
        const candidateId = `unit:ts:${current || "."}`;
        if (unitIds.has(candidateId)) {
          importedUnits.add(candidateId);
          break;
        }
        const parent = dirname(current);
        if (parent === current || parent === ".") {
          if (unitIds.has("unit:ts:.")) importedUnits.add("unit:ts:.");
          break;
        }
        current = parent;
      }
    }

    return [...importedUnits];
  }

  private parseTscOutput(output: string, repoRoot: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    // Format: file(line,col): error TSxxxx: message
    const re = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/gm;
    let match;
    while ((match = re.exec(output)) !== null) {
      const [, filePath, lineStr, colStr, severity, code, message] = match;
      if (!filePath || !lineStr) continue;
      const relPath = relative(repoRoot, resolve(repoRoot, filePath));
      if (relPath.startsWith("..") || relPath.includes("node_modules")) continue;
      diagnostics.push({
        file_id: `file:${relPath}`,
        position: {
          line: parseInt(lineStr, 10),
          column: parseInt(colStr ?? "1", 10),
        },
        severity: severity === "error" ? "error" : "warning",
        message: `${code}: ${message}`,
        tool: "tsc",
      });
    }
    return diagnostics;
  }

  private parseEslintOutput(output: string, repoRoot: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    try {
      const results = JSON.parse(output);
      for (const file of results) {
        if (!file.filePath || !file.messages?.length) continue;
        const relPath = relative(repoRoot, file.filePath);
        if (relPath.startsWith("..") || relPath.includes("node_modules")) continue;
        for (const msg of file.messages) {
          diagnostics.push({
            file_id: `file:${relPath}`,
            position: {
              line: msg.line ?? 1,
              column: msg.column ?? 1,
            },
            severity: msg.severity === 2 ? "error" : "warning",
            message: `${msg.ruleId ?? "eslint"}: ${msg.message}`,
            tool: "eslint",
          });
        }
      }
    } catch { /* ignore malformed JSON */ }
    return diagnostics;
  }
}

// CSharpLanguageAdapter — CSHARP_SPEC.md

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
  collectFiles,
  detectCyclicDeps,
  hashSig,
  LspClient,
  type LspDocumentSymbol,
} from "../shared/index.ts";

/** Build env for dotnet-dependent subprocesses (csharp-ls, omnisharp). */
function buildDotnetEnv(): Record<string, string> {
  const dotnetRoot = process.env["DOTNET_ROOT"] ?? `${process.env["HOME"]}/.dotnet`;
  return {
    DOTNET_ROOT: dotnetRoot,
    PATH: `${dotnetRoot}:${dotnetRoot}/tools:${process.env["PATH"] ?? ""}`,
  };
}

/**
 * Check whether csharp-ls is available and functional.
 * Runs `csharp-ls --version` with DOTNET_ROOT set to ensure the .NET runtime is found.
 */
async function checkCsharpLs(): Promise<boolean> {
  const env = buildDotnetEnv();
  return exec(["csharp-ls", "--version"], { env })
    .then((r) => r.exitCode === 0)
    .catch(() => false);
}

// C# LSP SymbolKind mapping
const CS_SYMBOL_KIND_MAP: Record<number, string> = {
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
  22: "struct",
  23: "event",
};

export class CSharpLanguageAdapter implements LanguageAdapter {
  readonly lang = "csharp";

  async detect(repoRoot: string): Promise<DetectResult> {
    // Check for .sln files
    try {
      const entries = await readdir(repoRoot);
      if (entries.some((e) => e.endsWith(".sln"))) {
        return { supported: true, confidence: 1.0 };
      }
    } catch { /* ignore */ }
    // Check for .csproj files at root
    const csprojFiles = await this.findCsprojFiles(repoRoot, 1);
    if (csprojFiles.length > 0) {
      return { supported: true, confidence: 0.9 };
    }
    return { supported: false, confidence: 0 };
  }

  async doctor(): Promise<DoctorResult> {
    const missing: string[] = [];
    const notes: string[] = [];

    const dotnetPath = await whichTool("dotnet");
    if (!dotnetPath) {
      missing.push("dotnet");
    } else {
      const ver = await exec(["dotnet", "--version"]);
      if (ver.exitCode === 0) notes.push(`dotnet: ${ver.stdout}`);
    }

    // Check optional tools
    if (dotnetPath) {
      const toolList = await exec(["dotnet", "tool", "list", "--global"]);
      if (toolList.exitCode === 0) {
        const tools = toolList.stdout.toLowerCase();
        if (!tools.includes("dotnet-format")) {
          notes.push("dotnet-format not found (optional, may be built-in for .NET 6+)");
        }
      }
    }

    // Check LSP server for symbols/refs/call_edges/type_relations
    const csharpLsOk = await checkCsharpLs();
    const omnisharpPath = await whichTool("omnisharp");
    if (csharpLsOk) {
      notes.push("csharp-ls: available (LSP server for symbols/refs/call_edges/type_relations)");
    } else if (omnisharpPath) {
      notes.push("omnisharp: available (LSP server for symbols/refs/call_edges/type_relations)");
    } else {
      notes.push("csharp-ls not found (optional, needed for symbols/refs/call_edges/type_relations). Run bootstrap() to install.");
    }

    return { ok: missing.length === 0, missing_tools: missing, notes };
  }

  async bootstrap(): Promise<BootstrapResult> {
    const installed: string[] = [];
    const failed: Array<{ tool: string; reason: string }> = [];
    const notes: string[] = [];

    const dotnetPath = await whichTool("dotnet");
    if (!dotnetPath) {
      return {
        installed: [],
        failed: [{ tool: "dotnet", reason: "dotnet SDK not found. Install from https://dotnet.microsoft.com/" }],
        notes: [],
      };
    }

    // Install global tools
    const tools = [
      { name: "dotnet-format", pkg: "dotnet-format" },
      { name: "csharp-ls", pkg: "csharp-ls" },
    ];

    for (const { name, pkg } of tools) {
      const result = await exec(["dotnet", "tool", "install", "--global", pkg]);
      if (result.exitCode === 0) {
        installed.push(name);
      } else if (result.stderr?.includes("already installed")) {
        notes.push(`${name}: already installed`);
      } else {
        failed.push({ tool: name, reason: result.stderr });
      }
    }

    return { installed, failed, notes };
  }

  async enumerateUnits(
    repoRoot: string,
    _profile: Record<string, string>,
  ): Promise<Unit[]> {
    const csprojFiles = await this.findCsprojFiles(repoRoot);
    return csprojFiles.map((csprojPath) => {
      const relPath = relative(repoRoot, dirname(csprojPath));
      const projectName = basename(csprojPath, ".csproj");
      return {
        id: `unit:cs:${relPath || "."}`,
        kind: "cs_project",
        name: projectName,
        path: relPath || ".",
        metadata: {
          csproj: relative(repoRoot, csprojPath),
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

    for (const unit of units) {
      const unitDir = resolve(repoRoot, unit.path);
      const sourceFiles = await collectFiles(unitDir, [".cs", ".razor"], repoRoot);

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
      }

      // Parse project references from .csproj
      const csprojPath = unit.metadata?.["csproj"] as string | undefined;
      if (csprojPath) {
        const projDeps = await this.parseCsprojReferences(
          resolve(repoRoot, csprojPath),
          repoRoot,
          unitIds,
        );
        deps.push(...projDeps.map((depUnitId) => ({
          from_unit_id: unit.id,
          to_unit_id: depUnitId,
          kind: "project_reference",
        })));
      }
    }

    // --- csharp-ls / omnisharp LSP integration (degrade if unavailable) ---
    let lspCommand: string[] | null = null;
    const csharpLsOk = await checkCsharpLs();
    if (csharpLsOk) {
      lspCommand = ["csharp-ls"];
    } else if (await whichTool("omnisharp")) {
      lspCommand = ["omnisharp", "--languageserver"];
    }

    let symbols: Symbol[] = [];
    let refs: Ref[] = [];
    let typeRelations: TypeRelation[] = [];
    let callEdges: CallEdge[] = [];

    const allCsFiles = files
      .filter((f) => !f.generated && (f.path.endsWith(".cs") || f.path.endsWith(".razor")))
      .map((f) => ({ relPath: f.path, unitId: f.unit_id }));

    if (lspCommand && allCsFiles.length > 0) {
      const client = new LspClient(lspCommand, repoRoot, undefined, buildDotnetEnv(), { handleServerRequests: true });
      try {
        const result = await this.indexWithCsharpLs(repoRoot, allCsFiles, new Set(units.map((u) => u.id)), client);
        symbols = result.symbols;
        refs = result.refs;
        typeRelations = result.typeRelations;
        callEdges = result.callEdges;
      } catch {
        // C# LSP crashed or exited — degrade gracefully with empty LSP results
      } finally {
        await client.shutdown();
      }
    }

    return {
      added: { units, files, deps, symbols, refs, type_relations: typeRelations, call_edges: callEdges },
      removed: {},
    };
  }

  private async indexWithCsharpLs(
    repoRoot: string,
    csFiles: Array<{ relPath: string; unitId: string }>,
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

    // Track symbols by declaration position for ID lookup
    const symbolByPos = new Map<string, Symbol>(); // "relPath:line:col" -> Symbol
    // Track interface symbols for implementation queries
    const interfaceSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];
    const funcSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];

    // 0. Open all files and wait for workspace to load (csharp-ls loads project asynchronously)
    for (const { relPath } of csFiles) {
      await client.openDocument(relPath, "csharp");
    }

    // Poll until the workspace is ready: try documentSymbols on the first file until
    // we get non-empty results. Falls back after 90s timeout.
    // csharp-ls 0.22.0 does not send $/progress end, so a fixed wait is unreliable.
    // Use a short per-probe timeout (5s) so we don't block 120s on the first attempt.
    const firstFile = csFiles[0]?.relPath;
    if (firstFile) {
      const PROBE_TIMEOUT_MS = 5_000;
      const pollStart = Date.now();
      while (Date.now() - pollStart < 90_000) {
        try {
          const probe = await client.documentSymbols(firstFile, PROBE_TIMEOUT_MS);
          if (probe.length > 0) break;
        } catch { /* not ready yet — timeout or empty result */ }
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }

    // 1. Collect symbols from all files
    for (const { relPath, unitId } of csFiles) {
      let lspSyms;
      try {
        lspSyms = await client.documentSymbols(relPath);
      } catch {
        continue;
      }

      const flatSyms = this.flattenDocumentSymbols(lspSyms);
      for (const lspSym of flatSyms) {
        // Skip file-level (kind=1) and namespace-level (kind=3) symbols
        if (!CS_SYMBOL_KIND_MAP[lspSym.kind]) continue;
        // Use selectionRange (identifier name position) for LSP queries and position indexing
        const line = lspSym.selectionRange.start.line;
        const col = lspSym.selectionRange.start.character;
        const sym = this.lspSymbolToSymbol(lspSym, relPath, unitId);
        symbols.push(sym);
        symbolByPos.set(`${relPath}:${line}:${col}`, sym);

        if (sym.kind === "interface") {
          interfaceSymbols.push({ symbol: sym, relPath, line, col });
        }
        if (sym.kind === "method" || sym.kind === "function" || sym.kind === "constructor") {
          funcSymbols.push({ symbol: sym, relPath, line, col });
        }
      }
    }

    // 2. Collect call edges from methods/functions
    for (const { symbol, relPath, line, col } of funcSymbols) {
      let items;
      try {
        items = await client.prepareCallHierarchy(relPath, line, col);
      } catch {
        continue;
      }

      for (const item of items) {
        let outgoing;
        try {
          outgoing = await client.outgoingCalls(item);
        } catch {
          continue;
        }

        for (const call of outgoing) {
          const calleeRelPath = relative(repoRoot, LspClient.uriToPath(call.to.uri));
          // Use selectionRange (identifier position) to match symbolByPos keys
          const calleeLine = call.to.selectionRange.start.line;
          const calleeCol = call.to.selectionRange.start.character;
          let calleeSym = symbolByPos.get(`${calleeRelPath}:${calleeLine}:${calleeCol}`);
          // Fallback: try range.start if selectionRange didn't match
          if (!calleeSym) {
            calleeSym = symbolByPos.get(`${calleeRelPath}:${call.to.range.start.line}:${call.to.range.start.character}`);
          }
          if (!calleeSym) continue;
          if (!unitIds.has(calleeSym.unit_id)) continue;

          const callerFileId = `file:${relPath}`;
          for (const fromRange of call.fromRanges) {
            callEdges.push({
              caller_id: symbol.id,
              callee_id: calleeSym.id,
              site: {
                file_id: callerFileId,
                position: { line: fromRange.start.line + 1, column: fromRange.start.character + 1 },
              },
              dispatch: "static",
            });

            refs.push({
              from_symbol_id: symbol.id,
              to_symbol_id: calleeSym.id,
              site: {
                file_id: callerFileId,
                position: { line: fromRange.start.line + 1, column: fromRange.start.character + 1 },
              },
              kind: "call",
              confidence: "certain",
            });
          }
        }
      }
    }

    // 3. Collect non-call references (type_ref, field_access, reference)
    const refTargetSymbols = [
      ...interfaceSymbols,
      ...symbols
        .filter((s) => s.kind === "class" || s.kind === "struct" || s.kind === "field" ||
                       s.kind === "variable" || s.kind === "constant" || s.kind === "property")
        .map((s) => {
          const pos = s.decl.position;
          const relPath = s.decl.file_id.replace(/^file:/, "");
          // pos is 1-based; convert to 0-based for LSP queries
          return { symbol: s, relPath, line: pos.line - 1, col: pos.column - 1 };
        }),
    ];

    const callRefKeys = new Set(
      refs.map((r) => `${r.to_symbol_id}@${r.site.file_id}:${r.site.position.line}:${r.site.position.column}`),
    );

    for (const { symbol: targetSym, relPath: tRelPath, line: tLine, col: tCol } of refTargetSymbols) {
      let refLocs;
      try {
        refLocs = await client.references(tRelPath, tLine, tCol);
      } catch {
        continue;
      }

      for (const loc of refLocs) {
        const locRelPath = relative(repoRoot, LspClient.uriToPath(loc.uri));
        if (locRelPath === tRelPath && loc.range.start.line === tLine && loc.range.start.character === tCol) continue;

        const fileId = `file:${locRelPath}`;
        const locLine = loc.range.start.line + 1;
        const locCol = loc.range.start.character + 1;
        const refKey = `${targetSym.id}@${fileId}:${locLine}:${locCol}`;
        if (callRefKeys.has(refKey)) continue;

        const fromSymbol = this.findEnclosingSymbol(symbols, fileId, locLine);

        const kind = (targetSym.kind === "interface" || targetSym.kind === "class" || targetSym.kind === "struct")
          ? "type_ref"
          : (targetSym.kind === "field" || targetSym.kind === "property")
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

    // 4. Collect type relations (implementations)
    for (const { symbol, relPath, line, col } of interfaceSymbols) {
      let impls;
      try {
        impls = await client.implementation(relPath, line, col);
      } catch {
        continue;
      }

      for (const impl of impls) {
        const implRelPath = relative(repoRoot, LspClient.uriToPath(impl.uri));
        const implLine = impl.range.start.line;
        const implCol = impl.range.start.character;
        const implSym = symbolByPos.get(`${implRelPath}:${implLine}:${implCol}`);
        if (!implSym) continue;

        typeRelations.push({
          from_type_id: implSym.id,
          to_type_id: symbol.id,
          kind: "implements",
        });
      }
    }

    return { symbols, refs, typeRelations, callEdges };
  }

  private flattenDocumentSymbols(
    syms: LspDocumentSymbol[],
  ): LspDocumentSymbol[] {
    const result: LspDocumentSymbol[] = [];
    for (const sym of syms) {
      result.push(sym);
      if (sym.children && sym.children.length > 0) {
        result.push(...this.flattenDocumentSymbols(sym.children));
      }
    }
    return result;
  }

  private lspSymbolToSymbol(
    lspSym: LspDocumentSymbol,
    relPath: string,
    unitId: string,
  ): Symbol {
    const kind = CS_SYMBOL_KIND_MAP[lspSym.kind] ?? "unknown";
    // Use selectionRange (identifier name position) for precise declaration location
    const line = lspSym.selectionRange.start.line;
    const col = lspSym.selectionRange.start.character;
    const sigHash = hashSig(`${lspSym.name}:${lspSym.kind}:${line}`);
    const unitPath = unitId.replace(/^unit:cs:/, "");

    return {
      id: `sym:cs:${unitPath}#${kind}#${lspSym.name}#sig:${sigHash}`,
      unit_id: unitId,
      name: lspSym.name,
      kind,
      // C# access modifiers are not exposed by LSP documentSymbol — default to true
      exported: true,
      decl: {
        file_id: `file:${relPath}`,
        position: { line: line + 1, column: col + 1 },
      },
    };
  }

  private findEnclosingSymbol(
    symbols: Symbol[],
    fileId: string,
    line: number,
  ): Symbol | null {
    const fileFuncs = symbols
      .filter(
        (s) =>
          s.decl.file_id === fileId &&
          (s.kind === "method" || s.kind === "function" || s.kind === "constructor"),
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

    // 1. dotnet build (compilation warnings/errors)
    if (await whichTool("dotnet")) {
      const buildResult = await exec(
        ["dotnet", "build", "--no-restore", "-v", "quiet", "-nologo",
         "/property:GenerateFullPaths=true"],
        { cwd: repoRoot },
      );
      if (buildResult.exitCode !== 0 || buildResult.stdout) {
        diagnostics.push(...this.parseDotnetBuildOutput(
          buildResult.stdout + "\n" + buildResult.stderr,
          repoRoot,
        ));
      }
    }

    // 2. Circular dependency detection (compute deps from csproj only, no LSP startup)
    const allUnits = await this.enumerateUnits(repoRoot, _profile);
    const unitIds = new Set(allUnits.map((u) => u.id));
    const cycleDeps: Dep[] = [];
    for (const unit of allUnits) {
      const csprojPath = unit.metadata?.["csproj"] as string | undefined;
      if (csprojPath) {
        const projDeps = await this.parseCsprojReferences(
          resolve(repoRoot, csprojPath),
          repoRoot,
          unitIds,
        );
        cycleDeps.push(...projDeps.map((depUnitId) => ({
          from_unit_id: unit.id,
          to_unit_id: depUnitId,
          kind: "project_reference",
        })));
      }
    }
    diagnostics.push(...detectCyclicDeps(cycleDeps, "unit:cs:"));

    return diagnostics;
  }

  // --- Private helpers ---

  private async findCsprojFiles(repoRoot: string, maxDepth?: number): Promise<string[]> {
    const results: string[] = [];
    const skipDirs = new Set([
      "node_modules", ".git", "bin", "obj", "packages",
      "TestResults", "cache", ".vs",
    ]);

    async function walk(dir: string, depth: number): Promise<void> {
      if (maxDepth !== undefined && depth > maxDepth) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory() && !skipDirs.has(entry.name)) {
          await walk(fullPath, depth + 1);
        } else if (entry.name.endsWith(".csproj")) {
          results.push(fullPath);
        }
      }
    }

    await walk(repoRoot, 0);
    return results;
  }

  private async parseCsprojReferences(
    csprojPath: string,
    repoRoot: string,
    unitIds: Set<string>,
  ): Promise<string[]> {
    const file = Bun.file(csprojPath);
    let content: string;
    try {
      content = await file.text();
    } catch {
      return [];
    }

    const deps: string[] = [];
    // Match: <ProjectReference Include="..." />
    const re = /<ProjectReference\s+Include="([^"]+)"/g;
    let match;
    while ((match = re.exec(content)) !== null) {
      const refPath = match[1]!.replace(/\\/g, "/");
      const absRef = resolve(dirname(csprojPath), refPath);
      const relDir = relative(repoRoot, dirname(absRef));
      const candidateId = `unit:cs:${relDir || "."}`;
      if (unitIds.has(candidateId)) {
        deps.push(candidateId);
      }
    }

    return deps;
  }

  private parseDotnetBuildOutput(output: string, repoRoot: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    // Format: file(line,col): severity CSxxxx: message [project]
    const re = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(\w+):\s*(.+?)(?:\s+\[.+\])?$/gm;
    let match;
    while ((match = re.exec(output)) !== null) {
      const [, filePath, lineStr, colStr, severity, code, message] = match;
      if (!filePath || !lineStr) continue;
      const relPath = relative(repoRoot, filePath);
      if (relPath.startsWith("..") || relPath.includes("obj/")) continue;
      diagnostics.push({
        file_id: `file:${relPath}`,
        position: {
          line: parseInt(lineStr, 10),
          column: parseInt(colStr ?? "1", 10),
        },
        severity: severity === "error" ? "error" : "warning",
        message: `${code}: ${message}`,
        tool: "dotnet_build",
      });
    }
    return diagnostics;
  }
}

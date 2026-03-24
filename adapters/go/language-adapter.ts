// GoLanguageAdapter — GO_SPEC.md §2-7, SPEC.md §8.1

import { resolve, relative } from "node:path";
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
import { exec, whichTool, hashFile, isGenerated } from "./utils.ts";
import { goList, type GoPackage } from "./go-list.ts";
import {
  goplsSymbols,
  goplsCallHierarchy,
  goplsImplementation,
  goplsReferences,
  type GoplsSymbol,
} from "./gopls.ts";
import { GoplsLspClient } from "./lsp-client.ts";

export class GoLanguageAdapter implements LanguageAdapter {
  readonly lang = "go";

  private externalClient: GoplsLspClient | null = null;

  setExternalLspClient(client: GoplsLspClient | null): void {
    this.externalClient = client;
  }

  async detect(repoRoot: string): Promise<DetectResult> {
    const goMod = Bun.file(resolve(repoRoot, "go.mod"));
    const exists = await goMod.exists();
    return { supported: exists, confidence: exists ? 1.0 : 0 };
  }

  async doctor(): Promise<DoctorResult> {
    const missing: string[] = [];
    const notes: string[] = [];

    const goPath = await whichTool("go");
    if (!goPath) {
      missing.push("go");
    } else {
      const ver = await exec(["go", "version"]);
      if (ver.exitCode === 0) notes.push(ver.stdout);
    }

    // Check optional tools (all installable via bootstrap())
    const optionalTools: Array<{ name: string; purpose: string }> = [
      { name: "gopls", purpose: "symbols/refs/call_edges/type_relations" },
      { name: "staticcheck", purpose: "advanced static analysis" },
      { name: "errcheck", purpose: "unchecked error detection" },
      { name: "gosec", purpose: "security analysis" },
      { name: "govulncheck", purpose: "dependency vulnerability scanning" },
      { name: "dupl", purpose: "code duplication detection" },
    ];

    const missingOptional: string[] = [];
    for (const { name, purpose } of optionalTools) {
      const toolPath = await whichTool(name);
      if (!toolPath) {
        missingOptional.push(name);
        notes.push(`${name} not found (optional, needed for ${purpose})`);
      } else {
        if (name === "gopls") {
          const ver = await exec(["gopls", "version"]);
          if (ver.exitCode === 0) notes.push(`gopls: ${ver.stdout.split("\n")[0]}`);
        } else {
          notes.push(`${name}: available`);
        }
      }
    }

    if (missingOptional.length > 0 && goPath) {
      notes.push(`Run bootstrap() to install: ${missingOptional.join(", ")}`);
    }

    return { ok: missing.length === 0, missing_tools: missing, notes };
  }

  // Go tools installable via `go install`
  private static readonly GO_TOOLS: Record<string, string> = {
    gopls: "golang.org/x/tools/gopls@latest",
    staticcheck: "honnef.co/go/tools/cmd/staticcheck@latest",
    errcheck: "github.com/kisielk/errcheck@latest",
    gosec: "github.com/securego/gosec/v2/cmd/gosec@latest",
    govulncheck: "golang.org/x/vuln/cmd/govulncheck@latest",
    dupl: "github.com/mibk/dupl@latest",
  };

  async bootstrap(): Promise<BootstrapResult> {
    const installed: string[] = [];
    const failed: Array<{ tool: string; reason: string }> = [];
    const notes: string[] = [];

    // Prerequisite: go must be available
    const goPath = await whichTool("go");
    if (!goPath) {
      return {
        installed: [],
        failed: [{ tool: "go", reason: "Go compiler not found. Install from https://go.dev/dl/" }],
        notes: ["go is required before other tools can be installed"],
      };
    }

    for (const [name, pkg] of Object.entries(GoLanguageAdapter.GO_TOOLS)) {
      if (await whichTool(name)) {
        notes.push(`${name}: already installed`);
        continue;
      }

      const result = await exec(["go", "install", pkg]);
      if (result.exitCode === 0) {
        // Verify it's now on PATH
        if (await whichTool(name)) {
          installed.push(name);
        } else {
          // Installed but not on PATH — check GOPATH/bin
          const goEnv = await exec(["go", "env", "GOPATH"]);
          const gopath = goEnv.stdout.trim();
          notes.push(
            `${name}: installed to ${gopath}/bin but not on PATH. Add to PATH: export PATH=$PATH:${gopath}/bin`,
          );
          installed.push(name);
        }
      } else {
        failed.push({
          tool: name,
          reason: result.stderr || `go install ${pkg} failed with exit code ${result.exitCode}`,
        });
      }
    }

    return { installed, failed, notes };
  }

  async enumerateUnits(
    repoRoot: string,
    profile: Record<string, string>,
  ): Promise<Unit[]> {
    const packages = await goList(repoRoot, profile);
    return packages
      .filter((p) => !p.Standard)
      .map((p) => this.packageToUnit(p, repoRoot));
  }

  async indexUnits(
    units: Unit[],
    profile: Record<string, string>,
  ): Promise<FactsDelta> {
    const repoRoot = units[0]?.metadata?.["repo_root"] as string | undefined;
    if (!repoRoot) {
      throw new Error("units must contain repo_root in metadata");
    }

    const packages = await goList(repoRoot, profile);
    const pkgByImportPath = new Map<string, GoPackage>();
    for (const p of packages) {
      pkgByImportPath.set(p.ImportPath, p);
    }

    const modulePath = packages[0]?.Module?.Path;
    const unitIds = new Set(units.map((u) => u.id));
    const files: File[] = [];
    const deps: Dep[] = [];

    // Collect all Go file paths for gopls processing
    const allGoFiles: Array<{ absPath: string; relPath: string; unitId: string }> = [];

    for (const unit of units) {
      const importPath = unit.metadata?.["import_path"] as string | undefined;
      const pkg = importPath ? pkgByImportPath.get(importPath) : undefined;
      if (!pkg) continue;

      const goFiles = pkg.GoFiles ?? [];
      for (const f of goFiles) {
        const absPath = resolve(pkg.Dir, f);
        const relPath = relative(repoRoot, absPath);
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
        // generated ファイルは gopls 解析対象から除外する
        if (!generated) {
          allGoFiles.push({ absPath, relPath, unitId: unit.id });
        }
      }

      // Deps — only repo-internal
      for (const imp of pkg.Imports ?? []) {
        if (!modulePath || !imp.startsWith(modulePath)) continue;
        const depPkg = pkgByImportPath.get(imp);
        if (!depPkg || depPkg.Standard) continue;
        const depRelPath = relative(repoRoot, depPkg.Dir);
        const depUnitId = `unit:go:${depRelPath}`;
        if (unitIds.has(depUnitId)) {
          deps.push({
            from_unit_id: unit.id,
            to_unit_id: depUnitId,
            kind: "import",
          });
        }
      }
    }

    // --- gopls integration (degrade if unavailable) ---
    const hasGopls = (await whichTool("gopls")) !== null;
    let symbols: Symbol[] = [];
    let refs: Ref[] = [];
    let typeRelations: TypeRelation[] = [];
    let callEdges: CallEdge[] = [];

    if (hasGopls && allGoFiles.length > 0) {
      const useExternalClient = this.externalClient !== null;
      const client = this.externalClient ?? new GoplsLspClient(repoRoot);
      try {
        const result = await this.indexWithGopls(
          repoRoot,
          allGoFiles,
          unitIds,
          client,
        );
        symbols = result.symbols;
        refs = result.refs;
        typeRelations = result.typeRelations;
        callEdges = result.callEdges;
      } finally {
        // 外部クライアントの場合は shutdown しない
        if (!useExternalClient) {
          await client.shutdown();
        }
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

  private async indexWithGopls(
    repoRoot: string,
    goFiles: Array<{ absPath: string; relPath: string; unitId: string }>,
    unitIds: Set<string>,
    client: GoplsLspClient,
  ): Promise<{
    symbols: Symbol[];
    refs: Ref[];
    typeRelations: TypeRelation[];
    callEdges: CallEdge[];
  }> {
    const symbols: Symbol[] = [];
    const callEdges: CallEdge[] = [];
    const typeRelations: TypeRelation[] = [];
    // refs are derived from call_edges (each call edge implies a reference)
    const refs: Ref[] = [];

    // Track symbols by their declaration position for ID lookup
    const symbolByPos = new Map<string, Symbol>(); // "file:line:col" -> Symbol
    // Track interface/struct symbols for implementation queries
    const interfaceSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];
    const funcSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];

    // 1. Collect symbols from all files
    for (const { relPath, unitId } of goFiles) {
      const goplsSyms = await goplsSymbols(relPath, repoRoot, client);

      for (const gSym of goplsSyms) {
        const sym = this.goplsSymbolToSymbol(gSym, relPath, unitId);
        symbols.push(sym);
        symbolByPos.set(`${relPath}:${gSym.line}:${gSym.startCol}`, sym);

        if (gSym.kind === "Interface") {
          interfaceSymbols.push({
            symbol: sym,
            relPath,
            line: gSym.line,
            col: gSym.startCol,
          });
        }

        if (gSym.kind === "Function" || gSym.kind === "Method") {
          funcSymbols.push({
            symbol: sym,
            relPath,
            line: gSym.line,
            col: gSym.startCol,
          });
        }

        // Process children (fields, embedded types)
        for (const child of gSym.children) {
          const childSym = this.goplsSymbolToSymbol(
            child,
            relPath,
            unitId,
          );
          symbols.push(childSym);
          symbolByPos.set(`${relPath}:${child.line}:${child.startCol}`, childSym);
        }
      }
    }

    // 2. Collect call edges from functions/methods
    for (const { symbol, relPath, line, col } of funcSymbols) {
      const hierarchy = await goplsCallHierarchy(relPath, line, col, repoRoot, client);
      if (!hierarchy) continue;

      for (const callee of hierarchy.outgoing) {
        const calleeRelPath = relative(repoRoot, callee.file);
        const calleeKey = `${calleeRelPath}:${callee.line}:${callee.col}`;
        const calleeSym = symbolByPos.get(calleeKey);
        if (!calleeSym) continue;

        // Only include edges within our repo units
        if (!unitIds.has(calleeSym.unit_id)) continue;

        const callerFileId = `file:${relPath}`;
        callEdges.push({
          caller_id: symbol.id,
          callee_id: calleeSym.id,
          site: {
            file_id: callerFileId,
            position: {
              line: callee.rangeLine,
              column: callee.rangeCol,
            },
          },
          dispatch: "static",
        });

        // Each call edge also implies a reference
        refs.push({
          from_symbol_id: symbol.id,
          to_symbol_id: calleeSym.id,
          site: {
            file_id: callerFileId,
            position: {
              line: callee.rangeLine,
              column: callee.rangeCol,
            },
          },
          kind: "call",
          confidence: "certain",
        });
      }
    }

    // 2b. Collect non-call references via textDocument/references
    // Query references for types, interfaces, and exported fields
    const refTargetSymbols = [
      ...interfaceSymbols,
      ...symbols
        .filter((s) => s.kind === "struct" || s.kind === "field" || s.kind === "variable" || s.kind === "constant")
        .map((s) => {
          const pos = s.decl.position;
          const relPath = s.decl.file_id.replace(/^file:/, "");
          return { symbol: s, relPath, line: pos.line, col: pos.column };
        }),
    ];

    // Collect a set of call-ref keys to avoid duplicates
    const callRefKeys = new Set(
      refs.map((r) => `${r.to_symbol_id}@${r.site.file_id}:${r.site.position.line}:${r.site.position.column}`),
    );

    // Build a reverse lookup: absPath → { relPath, symbols at that position }
    const symbolByAbsPos = new Map<string, Symbol>();
    for (const [key, sym] of symbolByPos) {
      const [relP, ln, cl] = key.split(":");
      const absPath = resolve(repoRoot, relP!);
      symbolByAbsPos.set(`${absPath}:${ln}:${cl}`, sym);
    }

    for (const { symbol: targetSym, relPath: tRelPath, line: tLine, col: tCol } of refTargetSymbols) {
      let refLocs: Awaited<ReturnType<typeof goplsReferences>>;
      try {
        refLocs = await goplsReferences(tRelPath, tLine, tCol, repoRoot, client);
      } catch {
        continue;
      }

      for (const loc of refLocs) {
        // Skip the declaration itself
        const locRelPath = relative(repoRoot, loc.file);
        if (locRelPath === tRelPath && loc.line === tLine && loc.col === tCol) continue;

        const fileId = `file:${locRelPath}`;

        // Skip if already covered by a call-derived ref
        const refKey = `${targetSym.id}@${fileId}:${loc.line}:${loc.col}`;
        if (callRefKeys.has(refKey)) continue;

        // Determine the referring symbol (the one whose scope contains this location)
        // Find the closest function/method that contains this reference site
        const fromSymbol = this.findEnclosingSymbol(symbols, fileId, loc.line);

        const kind = targetSym.kind === "interface" || targetSym.kind === "struct"
          ? "type_ref"
          : targetSym.kind === "field"
            ? "field_access"
            : "reference";

        refs.push({
          from_symbol_id: fromSymbol?.id ?? `file_scope:${locRelPath}`,
          to_symbol_id: targetSym.id,
          site: {
            file_id: fileId,
            position: { line: loc.line, column: loc.col },
          },
          kind,
          confidence: "certain",
        });
      }
    }

    // 3. Collect type relations (implementations)
    for (const { symbol, relPath, line, col } of interfaceSymbols) {
      if (symbol.kind !== "interface") continue;

      const impls = await goplsImplementation(relPath, line, col, repoRoot, client);
      for (const impl of impls) {
        const implRelPath = relative(repoRoot, impl.file);
        const implKey = `${implRelPath}:${impl.line}:${impl.col}`;
        const implSym = symbolByPos.get(implKey);
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

  private goplsSymbolToSymbol(
    gSym: GoplsSymbol,
    relPath: string,
    unitId: string,
  ): Symbol {
    const kind = this.mapSymbolKind(gSym.kind);
    const sigHash = this.hashSig(`${gSym.name}:${gSym.kind}:${gSym.line}`);
    const unitPath = unitId.replace(/^unit:go:/, "");
    const name = gSym.name;

    return {
      id: `sym:go:${unitPath}#${kind}#${name}#sig:${sigHash}`,
      unit_id: unitId,
      name,
      kind,
      exported: name.length > 0 && name[0] === name[0]!.toUpperCase() && name[0] !== name[0]!.toLowerCase(),
      decl: {
        file_id: `file:${relPath}`,
        position: {
          line: gSym.line,
          column: gSym.startCol,
        },
      },
      metadata: gSym.parentName ? { receiver: gSym.parentName } : undefined,
    };
  }

  /**
   * Find the enclosing function/method symbol for a given file position.
   * Returns the most specific (closest line) function that declares before the given line.
   */
  private findEnclosingSymbol(
    symbols: Symbol[],
    fileId: string,
    line: number,
  ): Symbol | null {
    // Collect all function/method symbols in this file, sorted by declaration line
    const fileFuncs = symbols
      .filter(
        (s) =>
          s.decl.file_id === fileId &&
          (s.kind === "function" || s.kind === "method"),
      )
      .sort((a, b) => a.decl.position.line - b.decl.position.line);

    // Find the function that contains the given line:
    // A function's range is [its decl line, next function's decl line - 1]
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

  private mapSymbolKind(goplsKind: string): string {
    const map: Record<string, string> = {
      Function: "function",
      Method: "method",
      Struct: "struct",
      Interface: "interface",
      Field: "field",
      Variable: "variable",
      Constant: "constant",
      Package: "package",
    };
    return map[goplsKind] ?? goplsKind.toLowerCase();
  }

  private hashSig(input: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(input);
    return hasher.digest("hex").slice(0, 8);
  }

  async diagnose(
    units: Unit[],
    _profile: Record<string, string>,
  ): Promise<Diagnostic[]> {
    const repoRoot = units[0]?.metadata?.["repo_root"] as string | undefined;
    if (!repoRoot) return [];

    const diagnostics: Diagnostic[] = [];

    // 1. go vet (always available)
    const vetResult = await exec(["go", "vet", "./..."], { cwd: repoRoot });
    if (vetResult.exitCode !== 0 || vetResult.stderr) {
      diagnostics.push(...parseVetOutput(vetResult.stderr, repoRoot));
    }

    // 2. staticcheck (optional, graceful degradation)
    if (await whichTool("staticcheck")) {
      const scResult = await exec(
        ["staticcheck", "-f", "json", "./..."],
        { cwd: repoRoot },
      );
      // staticcheck returns exit 1 when diagnostics found, but still produces valid output
      if (scResult.stdout) {
        diagnostics.push(...parseStaticcheckOutput(scResult.stdout, repoRoot));
      }
    }

    // 3. errcheck (optional, graceful degradation)
    if (await whichTool("errcheck")) {
      const ecResult = await exec(
        ["errcheck", "-abspath", "./..."],
        { cwd: repoRoot },
      );
      if (ecResult.exitCode !== 0 && ecResult.stdout) {
        diagnostics.push(...parseErrcheckOutput(ecResult.stdout, repoRoot));
      }
    }

    // 4. Circular dependency detection from deps
    const allUnits = await this.enumerateUnits(repoRoot, _profile);
    const allDelta = await this.buildDepsOnly(allUnits, repoRoot, _profile);
    diagnostics.push(...detectCyclicDeps(allDelta));

    // 5. gosec (optional, graceful degradation)
    if (await whichTool("gosec")) {
      const gsResult = await exec(
        ["gosec", "-fmt=json", "-quiet", "./..."],
        { cwd: repoRoot },
      );
      if (gsResult.stdout) {
        diagnostics.push(...parseGosecOutput(gsResult.stdout, repoRoot));
      }
    }

    // 6. dupl (optional, code duplication detection)
    if (await whichTool("dupl")) {
      const duplResult = await exec(
        ["dupl", "-plumbing", "-threshold", "50", "."],
        { cwd: repoRoot },
      );
      if (duplResult.stdout) {
        diagnostics.push(...parseDuplOutput(duplResult.stdout, repoRoot));
      }
    }

    // 7. govulncheck (optional, graceful degradation)
    if (await whichTool("govulncheck")) {
      const gvResult = await exec(
        ["govulncheck", "-json", "./..."],
        { cwd: repoRoot },
      );
      if (gvResult.stdout) {
        diagnostics.push(...parseGovulncheckOutput(gvResult.stdout, repoRoot));
      }
    }

    return diagnostics;
  }

  /**
   * Build deps only (lightweight, for cycle detection).
   */
  private async buildDepsOnly(
    units: Unit[],
    repoRoot: string,
    profile: Record<string, string>,
  ): Promise<Dep[]> {
    const packages = await goList(repoRoot, profile);
    const pkgByImportPath = new Map<string, GoPackage>();
    for (const p of packages) {
      pkgByImportPath.set(p.ImportPath, p);
    }
    const modulePath = packages[0]?.Module?.Path;
    const unitIds = new Set(units.map((u) => u.id));
    const deps: Dep[] = [];

    for (const unit of units) {
      const importPath = unit.metadata?.["import_path"] as string | undefined;
      const pkg = importPath ? pkgByImportPath.get(importPath) : undefined;
      if (!pkg) continue;
      for (const imp of pkg.Imports ?? []) {
        if (!modulePath || !imp.startsWith(modulePath)) continue;
        const depPkg = pkgByImportPath.get(imp);
        if (!depPkg || depPkg.Standard) continue;
        const depRelPath = relative(repoRoot, depPkg.Dir);
        const depUnitId = `unit:go:${depRelPath}`;
        if (unitIds.has(depUnitId)) {
          deps.push({ from_unit_id: unit.id, to_unit_id: depUnitId, kind: "import" });
        }
      }
    }
    return deps;
  }

  private packageToUnit(pkg: GoPackage, repoRoot: string): Unit {
    const relPath = relative(repoRoot, pkg.Dir) || ".";
    return {
      id: `unit:go:${relPath}`,
      kind: "go_package",
      name: pkg.Name,
      path: relPath,
      metadata: {
        import_path: pkg.ImportPath,
        module: pkg.Module?.Path,
        repo_root: repoRoot,
      },
    };
  }
}

/**
 * Parse `go vet` stderr output into Diagnostic[].
 * Format: <file>:<line>:<column>: <message>
 * or:     <file>:<line>: <message>
 */
export function parseVetOutput(
  stderr: string,
  repoRoot: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = stderr.split("\n");
  const re = /^(.+?):(\d+):(?:(\d+):)?\s*(.+)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    const match = re.exec(trimmed);
    if (!match) continue;
    const [, filePath, lineStr, colStr, message] = match;
    if (!filePath || !lineStr || !message) continue;
    const relPath = relative(repoRoot, resolve(repoRoot, filePath));
    diagnostics.push({
      file_id: `file:${relPath}`,
      position: {
        line: parseInt(lineStr, 10),
        column: colStr ? parseInt(colStr, 10) : 1,
      },
      severity: "warning",
      message,
      tool: "go_vet",
    });
  }
  return diagnostics;
}

/**
 * Parse staticcheck JSON output (one JSON object per line).
 * Format: {"code":"SA1000","severity":"error","location":{"file":"...","line":1,"column":1},"message":"..."}
 */
export function parseStaticcheckOutput(
  stdout: string,
  repoRoot: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry.location?.file) continue;
      const relPath = relative(repoRoot, entry.location.file);
      const severity = entry.severity === "error" ? "error" as const
        : entry.severity === "info" ? "info" as const
        : "warning" as const;
      diagnostics.push({
        file_id: `file:${relPath}`,
        position: {
          line: entry.location.line ?? 1,
          column: entry.location.column ?? 1,
        },
        severity,
        message: `${entry.code}: ${entry.message}`,
        tool: "staticcheck",
      });
    } catch {
      // Skip malformed lines
    }
  }
  return diagnostics;
}

/**
 * Parse errcheck output.
 * Format (with -abspath): /absolute/path/to/file.go:42:12:\tfmt.Fprintf(...)
 */
export function parseErrcheckOutput(
  stdout: string,
  repoRoot: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const re = /^(.+?):(\d+):(\d+):\t(.+)$/;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = re.exec(trimmed);
    if (!match) continue;
    const [, filePath, lineStr, colStr, expr] = match;
    if (!filePath || !lineStr) continue;
    const relPath = relative(repoRoot, filePath);
    // Skip files outside our repo
    if (relPath.startsWith("..")) continue;
    diagnostics.push({
      file_id: `file:${relPath}`,
      position: {
        line: parseInt(lineStr, 10),
        column: colStr ? parseInt(colStr, 10) : 1,
      },
      severity: "warning",
      message: `unchecked error: ${expr ?? ""}`.trim(),
      tool: "errcheck",
    });
  }
  return diagnostics;
}

/**
 * Detect circular dependencies in the dep graph using DFS.
 * Returns diagnostics for each cycle found.
 */
export function detectCyclicDeps(deps: Dep[]): Diagnostic[] {
  // Build adjacency list
  const adj = new Map<string, string[]>();
  for (const dep of deps) {
    const existing = adj.get(dep.from_unit_id);
    if (existing) {
      existing.push(dep.to_unit_id);
    } else {
      adj.set(dep.from_unit_id, [dep.to_unit_id]);
    }
  }

  const diagnostics: Diagnostic[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const reportedCycles = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (inStack.has(node)) {
      // Found a cycle — extract the cycle portion
      const cycleStart = path.indexOf(node);
      if (cycleStart === -1) return;
      const cycle = path.slice(cycleStart);
      cycle.push(node);
      // Normalize cycle key to avoid duplicate reports
      const cycleKey = [...cycle].sort().join(" -> ");
      if (reportedCycles.has(cycleKey)) return;
      reportedCycles.add(cycleKey);
      diagnostics.push({
        file_id: cycle[0]!,
        position: { line: 0, column: 0 },
        severity: "warning",
        message: `circular dependency detected: ${cycle.map((u) => u.replace(/^unit:go:/, "")).join(" -> ")}`,
        tool: "cycle_detector",
      });
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      dfs(neighbor, path);
    }

    path.pop();
    inStack.delete(node);
  }

  for (const node of adj.keys()) {
    dfs(node, []);
  }

  return diagnostics;
}

/**
 * Parse gosec JSON output.
 * gosec -fmt=json outputs: {"Issues":[{"severity":"HIGH","confidence":"HIGH","rule_id":"G101","details":"...","file":"...","line":"42","column":"12"},...]}
 */
export function parseGosecOutput(
  stdout: string,
  repoRoot: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  try {
    const data = JSON.parse(stdout);
    const issues = data?.Issues ?? data?.issues ?? [];
    for (const issue of issues) {
      if (!issue.file) continue;
      const relPath = relative(repoRoot, resolve(repoRoot, issue.file));
      if (relPath.startsWith("..")) continue;
      const severity = issue.severity === "HIGH" ? "error" as const
        : issue.severity === "MEDIUM" ? "warning" as const
        : "info" as const;
      diagnostics.push({
        file_id: `file:${relPath}`,
        position: {
          line: parseInt(issue.line ?? "1", 10),
          column: parseInt(issue.column ?? "1", 10),
        },
        severity,
        message: `${issue.rule_id ?? "gosec"}: ${issue.details ?? issue.description ?? "security issue"}`,
        tool: "gosec",
      });
    }
  } catch {
    // Malformed JSON — skip
  }
  return diagnostics;
}

/**
 * Parse dupl -plumbing output.
 * Format: groups of duplicate blocks separated by blank lines.
 * Each line within a group: <file>:<startLine>,<endLine>
 */
export function parseDuplOutput(
  stdout: string,
  repoRoot: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = stdout.split("\n");
  let currentGroup: Array<{ file: string; startLine: number; endLine: number }> = [];

  function flushGroup() {
    if (currentGroup.length < 2) {
      currentGroup = [];
      return;
    }
    // Report on each file in the group
    for (let i = 0; i < currentGroup.length; i++) {
      const entry = currentGroup[i]!;
      const others = currentGroup
        .filter((_, j) => j !== i)
        .map((o) => `${o.file}:${o.startLine}-${o.endLine}`)
        .join(", ");
      const relPath = relative(repoRoot, resolve(repoRoot, entry.file));
      if (relPath.startsWith("..")) continue;
      diagnostics.push({
        file_id: `file:${relPath}`,
        position: { line: entry.startLine, column: 1 },
        severity: "info",
        message: `duplicate code block (lines ${entry.startLine}-${entry.endLine}), also found at: ${others}`,
        tool: "dupl",
      });
    }
    currentGroup = [];
  }

  const re = /^(.+?):(\d+),(\d+)$/;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushGroup();
      continue;
    }
    const match = re.exec(trimmed);
    if (match) {
      const [, file, startStr, endStr] = match;
      currentGroup.push({
        file: file!,
        startLine: parseInt(startStr!, 10),
        endLine: parseInt(endStr!, 10),
      });
    }
  }
  flushGroup(); // flush last group

  return diagnostics;
}

/**
 * Parse govulncheck JSON output.
 * govulncheck -json outputs a stream of JSON objects. We look for "vulnerability" entries.
 */
export function parseGovulncheckOutput(
  stdout: string,
  _repoRoot: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // govulncheck -json outputs multi-line JSON objects (not NDJSON).
  // Parse using brace-counting like parseNDJSON in go-list.ts.
  const objects: unknown[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(stdout.slice(start, i + 1)));
        } catch {
          // skip malformed object
        }
        start = -1;
      }
    }
  }

  for (const msg of objects) {
    const obj = msg as Record<string, unknown>;
    const vuln = (obj.osv ?? obj.vulnerability) as Record<string, unknown> | undefined;
    if (vuln) {
      const id = (vuln.id as string) ?? "UNKNOWN";
      const summary = (vuln.summary ?? vuln.details ?? "known vulnerability") as string;
      diagnostics.push({
        file_id: "file:go.mod",
        position: { line: 1, column: 1 },
        severity: "error",
        message: `${id}: ${summary}`,
        tool: "govulncheck",
      });
    }
  }

  // Deduplicate by message
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    if (seen.has(d.message)) return false;
    seen.add(d.message);
    return true;
  });
}

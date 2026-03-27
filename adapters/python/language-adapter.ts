// PythonLanguageAdapter — PYTHON_SPEC.md

import { resolve, relative, dirname, basename, join } from "node:path";
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
  type LspDocumentSymbol,
  type LspLocation,
} from "../shared/index.ts";

export class PythonLanguageAdapter implements LanguageAdapter {
  readonly lang = "python";

  async detect(repoRoot: string): Promise<DetectResult> {
    // High confidence markers
    for (const marker of ["pyproject.toml", "setup.py", "setup.cfg"]) {
      if (await Bun.file(resolve(repoRoot, marker)).exists()) {
        return { supported: true, confidence: 1.0 };
      }
    }
    // Medium confidence
    if (await Bun.file(resolve(repoRoot, "requirements.txt")).exists()) {
      return { supported: true, confidence: 0.8 };
    }
    // Check for any .py file at root
    try {
      const entries = await readdir(repoRoot);
      if (entries.some((e) => e.endsWith(".py"))) {
        return { supported: true, confidence: 0.6 };
      }
    } catch { /* ignore */ }
    return { supported: false, confidence: 0 };
  }

  async doctor(): Promise<DoctorResult> {
    const missing: string[] = [];
    const notes: string[] = [];

    // Check python3 or python
    const py = (await whichTool("python3")) ?? (await whichTool("python"));
    if (!py) {
      missing.push("python");
    } else {
      const cmd = py.includes("python3") ? "python3" : "python";
      const ver = await exec([cmd, "--version"]);
      if (ver.exitCode === 0) notes.push(ver.stdout);
    }

    const optionalTools = [
      { name: "ruff", purpose: "fast linting and formatting" },
      { name: "mypy", purpose: "type checking" },
      { name: "pyright", purpose: "type checking (alternative)" },
      { name: "pyright-langserver", purpose: "symbols/refs/call_edges/type_relations (LSP)" },
      { name: "bandit", purpose: "security analysis" },
      { name: "pytest", purpose: "testing" },
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

    const pip = (await whichTool("pip3")) ?? (await whichTool("pip"));
    if (!pip) {
      return {
        installed: [],
        failed: [{ tool: "pip", reason: "pip not found. Install Python from https://python.org/" }],
        notes: [],
      };
    }

    const pipCmd = pip.includes("pip3") ? "pip3" : "pip";
    const tools = ["ruff", "mypy", "bandit", "pytest", "pyright"];

    for (const tool of tools) {
      if (await whichTool(tool)) {
        notes.push(`${tool}: already installed`);
        continue;
      }
      const result = await exec([pipCmd, "install", tool]);
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
    const units: Unit[] = [];

    // Strategy 1: pyproject.toml workspaces or single project
    const pyproject = Bun.file(resolve(repoRoot, "pyproject.toml"));
    if (await pyproject.exists()) {
      // Find Python packages (dirs with __init__.py)
      const packages = await this.findPythonPackages(repoRoot);
      if (packages.length > 0) {
        for (const pkg of packages) {
          units.push({
            id: `unit:py:${pkg.relPath}`,
            kind: "py_package",
            name: pkg.name,
            path: pkg.relPath,
            metadata: { repo_root: repoRoot },
          });
        }
      } else {
        // Single project at root
        units.push({
          id: "unit:py:.",
          kind: "py_project",
          name: basename(repoRoot),
          path: ".",
          metadata: { repo_root: repoRoot },
        });
      }
      return units;
    }

    // Strategy 2: Find Python packages
    const packages = await this.findPythonPackages(repoRoot);
    if (packages.length > 0) {
      for (const pkg of packages) {
        units.push({
          id: `unit:py:${pkg.relPath}`,
          kind: "py_package",
          name: pkg.name,
          path: pkg.relPath,
          metadata: { repo_root: repoRoot },
        });
      }
      return units;
    }

    // Strategy 3: Treat root as single unit
    units.push({
      id: "unit:py:.",
      kind: "py_project",
      name: basename(repoRoot),
      path: ".",
      metadata: { repo_root: repoRoot },
    });
    return units;
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

    // Collect all .py files for pyright processing
    const allPyFiles: Array<{ relPath: string; unitId: string }> = [];

    for (const unit of units) {
      const unitDir = resolve(repoRoot, unit.path);
      const sourceFiles = await collectFiles(unitDir, [".py", ".pyi"], repoRoot);

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

        if (!generated) {
          allPyFiles.push({ relPath, unitId: unit.id });
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

    // --- pyright LSP integration (degrade if unavailable) ---
    const pyrightCmd = (await whichTool("pyright-langserver")) !== null
      ? "pyright-langserver"
      : (await whichTool("basedpyright-langserver")) !== null
        ? "basedpyright-langserver"
        : null;

    let symbols: Symbol[] = [];
    let refs: Ref[] = [];
    let typeRelations: TypeRelation[] = [];
    let callEdges: CallEdge[] = [];

    if (pyrightCmd !== null && allPyFiles.length > 0) {
      const client = new LspClient([pyrightCmd, "--stdio"], repoRoot);
      try {
        const result = await this.indexWithPyright(repoRoot, allPyFiles, unitIds, client);
        symbols = result.symbols;
        refs = result.refs;
        typeRelations = result.typeRelations;
        callEdges = result.callEdges;
      } catch {
        // pyright crashed or exited — degrade gracefully with empty LSP results
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

  private async indexWithPyright(
    repoRoot: string,
    pyFiles: Array<{ relPath: string; unitId: string }>,
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

    const symbolByPos = new Map<string, Symbol>(); // "relPath:line:col" -> Symbol
    const funcSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];
    const refTargets: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];

    // Open all documents upfront (required by pyright before documentSymbol requests)
    for (const { relPath } of pyFiles) {
      try {
        await client.openDocument(relPath, "python");
      } catch {
        // Ignore — file may not exist or be unreadable
      }
    }

    // 1. Collect symbols from all files
    for (const { relPath, unitId } of pyFiles) {
      let lspSyms: LspDocumentSymbol[];
      try {
        lspSyms = await client.documentSymbols(relPath);
      } catch {
        continue;
      }

      const fileSyms = this.collectSymbolsFromLsp(lspSyms, relPath, unitId);
      for (const { symbol: sym, line, col } of fileSyms) {
        symbols.push(sym);
        symbolByPos.set(`${relPath}:${line}:${col}`, sym);

        if (sym.kind === "function" || sym.kind === "method") {
          funcSymbols.push({ symbol: sym, relPath, line, col });
        }
        if (sym.kind === "class" || sym.kind === "field" || sym.kind === "variable" || sym.kind === "constant") {
          refTargets.push({ symbol: sym, relPath, line, col });
        }
      }
    }

    // 2. Collect call edges from functions/methods
    for (const { symbol, relPath, line, col } of funcSymbols) {
      let hierarchy;
      try {
        hierarchy = await client.prepareCallHierarchy(relPath, line, col);
      } catch {
        continue;
      }

      for (const item of hierarchy) {
        let outgoing;
        try {
          outgoing = await client.outgoingCalls(item);
        } catch {
          continue;
        }

        for (const call of outgoing) {
          const calleeAbsPath = LspClient.uriToPath(call.to.uri);
          const calleeRelPath = relative(repoRoot, calleeAbsPath);
          const calleeLine = call.to.selectionRange.start.line;
          const calleeCol = call.to.selectionRange.start.character;
          const calleeSym = symbolByPos.get(`${calleeRelPath}:${calleeLine}:${calleeCol}`);
          if (!calleeSym) continue;
          if (!unitIds.has(calleeSym.unit_id)) continue;

          const callSite = call.fromRanges[0];
          if (!callSite) continue;
          const callerFileId = `file:${relPath}`;

          callEdges.push({
            caller_id: symbol.id,
            callee_id: calleeSym.id,
            site: {
              file_id: callerFileId,
              position: { line: callSite.start.line + 1, column: callSite.start.character + 1 },
            },
            dispatch: "static",
          });

          refs.push({
            from_symbol_id: symbol.id,
            to_symbol_id: calleeSym.id,
            site: {
              file_id: callerFileId,
              position: { line: callSite.start.line + 1, column: callSite.start.character + 1 },
            },
            kind: "call",
            confidence: "certain",
          });
        }
      }
    }

    // 3. Collect type relations from class inheritance (source-based)
    // pyright does not support textDocument/implementation, so we parse
    // "class Foo(Bar):" patterns directly from source.
    const inheritanceRelations = await this.detectClassInheritance(repoRoot, pyFiles, symbols);
    typeRelations.push(...inheritanceRelations);

    // 4. Collect non-call references
    const callRefKeys = new Set(
      refs.map((r) => `${r.to_symbol_id}@${r.site.file_id}:${r.site.position.line}:${r.site.position.column}`),
    );

    for (const { symbol: targetSym, relPath: tRelPath, line: tLine, col: tCol } of refTargets) {
      let refLocs: LspLocation[];
      try {
        refLocs = await client.references(tRelPath, tLine, tCol);
      } catch {
        continue;
      }

      for (const loc of refLocs) {
        const locAbsPath = LspClient.uriToPath(loc.uri);
        const locRelPath = relative(repoRoot, locAbsPath);

        // Skip declaration itself
        if (locRelPath === tRelPath && loc.range.start.line === tLine && loc.range.start.character === tCol) continue;

        const fileId = `file:${locRelPath}`;
        const locLine = loc.range.start.line + 1;
        const locCol = loc.range.start.character + 1;
        const refKey = `${targetSym.id}@${fileId}:${locLine}:${locCol}`;
        if (callRefKeys.has(refKey)) continue;

        const fromSymbol = this.findEnclosingSymbol(symbols, fileId, locLine);

        const kind = targetSym.kind === "class"
          ? "type_ref"
          : targetSym.kind === "field"
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

    return { symbols, refs, typeRelations, callEdges };
  }

  private collectSymbolsFromLsp(
    lspSyms: LspDocumentSymbol[],
    relPath: string,
    unitId: string,
  ): Array<{ symbol: Symbol; line: number; col: number }> {
    const result: Array<{ symbol: Symbol; line: number; col: number }> = [];
    for (const lspSym of lspSyms) {
      const line = lspSym.selectionRange.start.line;
      const col = lspSym.selectionRange.start.character;
      const sym = this.lspSymbolToPySymbol(lspSym, relPath, unitId, line, col);
      result.push({ symbol: sym, line, col });
      if (lspSym.children) {
        result.push(...this.collectSymbolsFromLsp(lspSym.children, relPath, unitId));
      }
    }
    return result;
  }

  private lspSymbolToPySymbol(
    lspSym: LspDocumentSymbol,
    relPath: string,
    unitId: string,
    line: number,
    col: number,
  ): Symbol {
    const kind = this.mapLspSymbolKind(lspSym.kind);
    const name = lspSym.name;
    const unitPath = unitId.replace(/^unit:py:/, "");
    const sigHash = hashSig(`${name}:${kind}:${line}`);

    return {
      id: `sym:py:${unitPath}#${kind}#${name}#sig:${sigHash}`,
      unit_id: unitId,
      name,
      kind,
      // Python: exported if name doesn't start with '_'
      exported: !name.startsWith("_"),
      decl: {
        file_id: `file:${relPath}`,
        position: { line: line + 1, column: col + 1 },
      },
    };
  }

  private mapLspSymbolKind(kind: number): string {
    const map: Record<number, string> = {
      2: "module",
      5: "class",
      6: "method",
      8: "field",
      12: "function",
      13: "variable",
      14: "constant",
    };
    return map[kind] ?? "unknown";
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
    const fileFuncs = symbols
      .filter(
        (s) =>
          s.decl.file_id === fileId &&
          (s.kind === "function" || s.kind === "method"),
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

  /**
   * Detect class inheritance relations by parsing source files.
   * pyright does not support textDocument/implementation, so we parse
   * `class Foo(Bar, Baz):` patterns directly and map to TypeRelation.
   * Only relations between known symbols (within our unit set) are emitted.
   */
  private async detectClassInheritance(
    repoRoot: string,
    pyFiles: Array<{ relPath: string; unitId: string }>,
    symbols: Symbol[],
  ): Promise<TypeRelation[]> {
    const relations: TypeRelation[] = [];

    // Build class name → symbol map
    const classByName = new Map<string, Symbol>();
    for (const sym of symbols) {
      if (sym.kind === "class") {
        classByName.set(sym.name, sym);
      }
    }

    const re = /^class\s+(\w+)\s*\(([^)]+)\)\s*:/gm;

    for (const { relPath } of pyFiles) {
      let content: string;
      try {
        content = await Bun.file(resolve(repoRoot, relPath)).text();
      } catch {
        continue;
      }

      re.lastIndex = 0;
      let match;
      while ((match = re.exec(content)) !== null) {
        const [, className, basesStr] = match;
        if (!className || !basesStr) continue;

        const classSymbol = classByName.get(className);
        if (!classSymbol) continue;

        // Split base classes, handle dotted names by taking the last component
        const bases = basesStr
          .split(",")
          .map((b) => b.trim().split(".").pop()!)
          .filter(Boolean);

        for (const base of bases) {
          const baseSymbol = classByName.get(base);
          if (!baseSymbol) continue; // Skip stdlib / external bases

          relations.push({
            from_type_id: classSymbol.id,
            to_type_id: baseSymbol.id,
            kind: "implements",
          });
        }
      }
    }

    return relations;
  }

  async diagnose(
    units: Unit[],
    _profile: Record<string, string>,
  ): Promise<Diagnostic[]> {
    const repoRoot = units[0]?.metadata?.["repo_root"] as string | undefined;
    if (!repoRoot) return [];

    const diagnostics: Diagnostic[] = [];

    // 1. ruff check (fast linter)
    if (await whichTool("ruff")) {
      const ruffResult = await exec(
        ["ruff", "check", "--output-format", "json", "."],
        { cwd: repoRoot },
      );
      if (ruffResult.stdout) {
        diagnostics.push(...this.parseRuffOutput(ruffResult.stdout, repoRoot));
      }
    }

    // 2. mypy (type checking, optional)
    if (await whichTool("mypy")) {
      const mypyResult = await exec(
        ["mypy", "--no-color-output", "--no-error-summary", "."],
        { cwd: repoRoot },
      );
      if (mypyResult.exitCode !== 0) {
        diagnostics.push(...this.parseMypyOutput(mypyResult.stdout, repoRoot));
      }
    }

    // 3. bandit (security, optional)
    if (await whichTool("bandit")) {
      const banditResult = await exec(
        ["bandit", "-r", "-f", "json", "."],
        { cwd: repoRoot },
      );
      if (banditResult.stdout) {
        diagnostics.push(...this.parseBanditOutput(banditResult.stdout, repoRoot));
      }
    }

    // 4. Circular dependency detection
    const allUnits = await this.enumerateUnits(repoRoot, _profile);
    const delta = await this.indexUnits(allUnits, _profile);
    if (delta.added.deps) {
      diagnostics.push(...detectCyclicDeps(delta.added.deps, "unit:py:"));
    }

    return diagnostics;
  }

  // --- Private helpers ---

  private async findPythonPackages(
    repoRoot: string,
  ): Promise<Array<{ name: string; relPath: string }>> {
    const packages: Array<{ name: string; relPath: string }> = [];
    const skipDirs = new Set([
      "node_modules", ".git", ".venv", "venv", "__pycache__",
      "dist", "build", "cache", ".mypy_cache", ".ruff_cache",
      ".tox", ".eggs", "*.egg-info",
    ]);

    async function walk(dir: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      const hasInit = entries.some((e) => e.name === "__init__.py");
      if (hasInit && dir !== repoRoot) {
        const relPath = relative(repoRoot, dir);
        packages.push({ name: basename(dir), relPath });
        // Don't recurse into sub-packages (they get their own unit)
      }

      for (const entry of entries) {
        if (entry.isDirectory() && !skipDirs.has(entry.name) && !entry.name.startsWith(".")) {
          await walk(resolve(dir, entry.name));
        }
      }
    }

    await walk(repoRoot);
    return packages;
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
    // Match: import X / from X import Y
    const re = /^(?:import|from)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/gm;
    let match;
    while ((match = re.exec(content)) !== null) {
      const moduleName = match[1]!;
      const topLevel = moduleName.split(".")[0]!;
      // Check if this maps to a known unit
      // Try the full dotted path first, converting dots to /
      const asPath = moduleName.replace(/\./g, "/");
      for (const candidate of [asPath, topLevel]) {
        const candidateId = `unit:py:${candidate}`;
        if (unitIds.has(candidateId)) {
          importedUnits.add(candidateId);
          break;
        }
      }
    }

    return [...importedUnits];
  }

  private parseRuffOutput(output: string, repoRoot: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    try {
      const results = JSON.parse(output);
      for (const item of results) {
        if (!item.filename) continue;
        const relPath = relative(repoRoot, resolve(repoRoot, item.filename));
        if (relPath.startsWith("..")) continue;
        diagnostics.push({
          file_id: `file:${relPath}`,
          position: {
            line: item.location?.row ?? 1,
            column: item.location?.column ?? 1,
          },
          severity: item.fix ? "warning" : "error",
          message: `${item.code}: ${item.message}`,
          tool: "ruff",
        });
      }
    } catch { /* ignore malformed JSON */ }
    return diagnostics;
  }

  private parseMypyOutput(output: string, repoRoot: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    // Format: file:line: severity: message
    const re = /^(.+?):(\d+):\s*(error|warning|note):\s*(.+)$/gm;
    let match;
    while ((match = re.exec(output)) !== null) {
      const [, filePath, lineStr, severity, message] = match;
      if (!filePath || !lineStr) continue;
      const relPath = relative(repoRoot, resolve(repoRoot, filePath));
      if (relPath.startsWith("..")) continue;
      diagnostics.push({
        file_id: `file:${relPath}`,
        position: { line: parseInt(lineStr, 10), column: 1 },
        severity: severity === "error" ? "error" : severity === "note" ? "info" : "warning",
        message,
        tool: "mypy",
      });
    }
    return diagnostics;
  }

  private parseBanditOutput(output: string, repoRoot: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    try {
      const data = JSON.parse(output);
      for (const result of data.results ?? []) {
        if (!result.filename) continue;
        const relPath = relative(repoRoot, resolve(repoRoot, result.filename));
        if (relPath.startsWith("..")) continue;
        const severity = result.issue_severity === "HIGH" ? "error" as const
          : result.issue_severity === "MEDIUM" ? "warning" as const
          : "info" as const;
        diagnostics.push({
          file_id: `file:${relPath}`,
          position: {
            line: result.line_number ?? 1,
            column: 1,
          },
          severity,
          message: `${result.test_id}: ${result.issue_text}`,
          tool: "bandit",
        });
      }
    } catch { /* ignore malformed JSON */ }
    return diagnostics;
  }
}

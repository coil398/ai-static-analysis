// RustLanguageAdapter — RUST_SPEC.md

import { resolve, relative, dirname, basename } from "node:path";
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
} from "../shared/index.ts";

interface CargoMetadataPackage {
  name: string;
  id: string;
  manifest_path: string;
  dependencies: Array<{
    name: string;
    kind: string | null;
    path?: string;
  }>;
}

interface CargoMetadata {
  packages: CargoMetadataPackage[];
  workspace_members: string[];
}

export class RustLanguageAdapter implements LanguageAdapter {
  readonly lang = "rust";

  async detect(repoRoot: string): Promise<DetectResult> {
    const cargoToml = Bun.file(resolve(repoRoot, "Cargo.toml"));
    const exists = await cargoToml.exists();
    return { supported: exists, confidence: exists ? 1.0 : 0 };
  }

  async doctor(): Promise<DoctorResult> {
    const missing: string[] = [];
    const notes: string[] = [];

    const rustcPath = await whichTool("rustc");
    if (!rustcPath) {
      missing.push("rustc");
    } else {
      const ver = await exec(["rustc", "--version"]);
      if (ver.exitCode === 0) notes.push(ver.stdout);
    }

    const cargoPath = await whichTool("cargo");
    if (!cargoPath) {
      missing.push("cargo");
    } else {
      const ver = await exec(["cargo", "--version"]);
      if (ver.exitCode === 0) notes.push(ver.stdout);
    }

    const optionalTools = [
      { name: "clippy-driver", purpose: "advanced linting (cargo clippy)" },
      { name: "rustfmt", purpose: "formatting (cargo fmt)" },
      { name: "rust-analyzer", purpose: "symbols/refs/type_relations" },
      { name: "cargo-audit", purpose: "dependency vulnerability scanning" },
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

    const rustupPath = await whichTool("rustup");
    const cargoPath = await whichTool("cargo");

    if (!rustupPath && !cargoPath) {
      return {
        installed: [],
        failed: [{ tool: "rust", reason: "Rust not found. Install from https://rustup.rs/" }],
        notes: [],
      };
    }

    // rustup components
    if (rustupPath) {
      for (const component of ["clippy", "rustfmt", "rust-analyzer"]) {
        if (component === "clippy" && (await whichTool("clippy-driver"))) {
          notes.push(`${component}: already installed`);
          continue;
        }
        if (component === "rustfmt" && (await whichTool("rustfmt"))) {
          notes.push(`${component}: already installed`);
          continue;
        }
        if (component === "rust-analyzer" && (await whichTool("rust-analyzer"))) {
          notes.push(`${component}: already installed`);
          continue;
        }
        const result = await exec(["rustup", "component", "add", component]);
        if (result.exitCode === 0) {
          installed.push(component);
        } else {
          failed.push({ tool: component, reason: result.stderr });
        }
      }
    }

    // cargo install tools
    if (cargoPath) {
      const cargoTools = [
        { name: "cargo-audit", pkg: "cargo-audit" },
      ];
      for (const { name, pkg } of cargoTools) {
        if (await whichTool(name)) {
          notes.push(`${name}: already installed`);
          continue;
        }
        const result = await exec(["cargo", "install", pkg], { timeoutMs: 120_000 });
        if (result.exitCode === 0) {
          installed.push(name);
        } else {
          failed.push({ tool: name, reason: result.stderr || `cargo install ${pkg} failed or timed out` });
        }
      }
    }

    return { installed, failed, notes };
  }

  async enumerateUnits(
    repoRoot: string,
    _profile: Record<string, string>,
  ): Promise<Unit[]> {
    const metadata = await this.cargoMetadata(repoRoot);
    if (!metadata) return [];

    const memberIds = new Set(metadata.workspace_members);
    return metadata.packages
      .filter((p) => memberIds.has(p.id))
      .map((p) => {
        const manifestDir = dirname(p.manifest_path);
        const relPath = relative(repoRoot, manifestDir) || ".";
        return {
          id: `unit:rs:${relPath}`,
          kind: "rust_crate",
          name: p.name,
          path: relPath,
          metadata: {
            cargo_id: p.id,
            manifest_path: relative(repoRoot, p.manifest_path),
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

    // Build package name → unit id mapping
    const metadata = await this.cargoMetadata(repoRoot);
    const pkgNameToUnit = new Map<string, string>();
    if (metadata) {
      for (const unit of units) {
        const cargoId = unit.metadata?.["cargo_id"] as string;
        const pkg = metadata.packages.find((p) => p.id === cargoId);
        if (pkg) {
          pkgNameToUnit.set(pkg.name, unit.id);
        }
      }
    }

    for (const unit of units) {
      const unitDir = resolve(repoRoot, unit.path);
      // Rust source is typically in src/
      const srcDir = resolve(unitDir, "src");
      const sourceFiles = await collectFiles(srcDir, [".rs"], repoRoot);
      // Also check for files in the unit root (build.rs, etc)
      const rootFiles = await collectFiles(unitDir, [".rs"], repoRoot);
      const allFiles = [...new Set([...sourceFiles, ...rootFiles.filter((f) => {
        const name = basename(f);
        return name === "build.rs" || !f.includes("/src/");
      })])];

      for (const relPath of allFiles) {
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

      // Extract deps from cargo metadata
      if (metadata) {
        const cargoId = unit.metadata?.["cargo_id"] as string;
        const pkg = metadata.packages.find((p) => p.id === cargoId);
        if (pkg) {
          for (const dep of pkg.dependencies) {
            // Only include workspace-internal deps (those with path)
            const depUnitId = pkgNameToUnit.get(dep.name);
            if (depUnitId && depUnitId !== unit.id) {
              if (!deps.some(
                (d) => d.from_unit_id === unit.id && d.to_unit_id === depUnitId,
              )) {
                deps.push({
                  from_unit_id: unit.id,
                  to_unit_id: depUnitId,
                  kind: dep.kind === "dev" ? "dev_dependency" : "dependency",
                });
              }
            }
          }
        }
      }
    }

    // --- rust-analyzer LSP 統合 (degrade if unavailable) ---
    const hasRustAnalyzer = (await whichTool("rust-analyzer")) !== null;
    let symbols: Symbol[] = [];
    let refs: Ref[] = [];
    let typeRelations: TypeRelation[] = [];
    let callEdges: CallEdge[] = [];

    const allRsFiles = files
      .filter((f) => !f.generated && f.path.endsWith(".rs"))
      .map((f) => ({ relPath: f.path, unitId: f.unit_id }));

    if (hasRustAnalyzer && allRsFiles.length > 0) {
      const client = new LspClient(["rust-analyzer"], repoRoot);
      try {
        const result = await this.indexWithRustAnalyzer(repoRoot, allRsFiles, unitIds, client);
        symbols = result.symbols;
        refs = result.refs;
        typeRelations = result.typeRelations;
        callEdges = result.callEdges;
      } catch {
        // rust-analyzer crashed or exited — degrade gracefully with empty LSP results
      } finally {
        await client.shutdown();
      }
    }

    return {
      added: { units, files, deps, symbols, refs, type_relations: typeRelations, call_edges: callEdges },
      removed: {},
    };
  }

  private async indexWithRustAnalyzer(
    repoRoot: string,
    rsFiles: Array<{ relPath: string; unitId: string }>,
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

    // Phase 1: Open ALL files first, store their contents.
    // rust-analyzer needs textDocument/didOpen before any LSP query.
    const fileContents = new Map<string, string>(); // relPath → content
    for (const { relPath } of rsFiles) {
      try {
        const absPath = resolve(repoRoot, relPath);
        const content = await Bun.file(absPath).text();
        await client.openDocument(relPath, "rust");
        fileContents.set(relPath, content);
      } catch {
        // ignore — queries will fail gracefully below
      }
    }

    // Wait for rust-analyzer to finish workspace indexing before querying.
    // Without this, outgoingCalls/implementation may fail with "content modified".
    try {
      await client.waitForWorkspaceReady(30_000);
    } catch {
      // rust-analyzer crashed during workspace indexing — return what we have so far
      return { symbols: [], refs: [], typeRelations: [], callEdges: [] };
    }

    // Track symbols by declaration position for ID lookup
    const symbolByPos = new Map<string, Symbol>(); // "relPath:line:col" -> Symbol
    // Secondary lookup by name for cases where impl() returns impl-block positions
    const symbolsByName = new Map<string, Symbol[]>(); // name → symbols

    const traitSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];
    const funcSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];

    // Phase 2: Collect symbols
    for (const { relPath, unitId } of rsFiles) {
      let lspSyms: LspDocumentSymbol[];
      try {
        lspSyms = await client.documentSymbols(relPath);
      } catch {
        continue;
      }

      const flatSyms = this.flattenDocumentSymbols(lspSyms, relPath, unitId);
      for (const { sym, lspSym } of flatSyms) {
        symbols.push(sym);
        symbolByPos.set(`${relPath}:${lspSym.selectionRange.start.line}:${lspSym.selectionRange.start.character}`, sym);
        const existing = symbolsByName.get(sym.name) ?? [];
        existing.push(sym);
        symbolsByName.set(sym.name, existing);

        if (sym.kind === "trait") {
          traitSymbols.push({
            symbol: sym,
            relPath,
            line: lspSym.selectionRange.start.line,
            col: lspSym.selectionRange.start.character,
          });
        }

        if (sym.kind === "function" || sym.kind === "method") {
          funcSymbols.push({
            symbol: sym,
            relPath,
            line: lspSym.selectionRange.start.line,
            col: lspSym.selectionRange.start.character,
          });
        }
      }
    }

    // Phase 3: Collect call edges from functions/methods
    for (const { symbol, relPath, line, col } of funcSymbols) {
      let hierarchy: Awaited<ReturnType<typeof client.prepareCallHierarchy>>;
      try {
        hierarchy = await client.prepareCallHierarchy(relPath, line, col);
      } catch {
        continue;
      }
      if (hierarchy.length === 0) continue;

      let outgoing: Awaited<ReturnType<typeof client.outgoingCalls>>;
      try {
        outgoing = await client.outgoingCalls(hierarchy[0]!);
      } catch {
        continue;
      }

      for (const call of outgoing) {
        const calleeRelPath = relative(repoRoot, LspClient.uriToPath(call.to.uri));
        const calleeKey = `${calleeRelPath}:${call.to.selectionRange.start.line}:${call.to.selectionRange.start.character}`;
        const calleeSym = symbolByPos.get(calleeKey);
        if (!calleeSym) continue;
        if (!unitIds.has(calleeSym.unit_id)) continue;

        const siteRange = call.fromRanges[0];
        const siteLine = siteRange?.start.line ?? line;
        const siteCol = siteRange?.start.character ?? col;
        const callerFileId = `file:${relPath}`;

        callEdges.push({
          caller_id: symbol.id,
          callee_id: calleeSym.id,
          site: {
            file_id: callerFileId,
            position: { line: siteLine + 1, column: siteCol + 1 },
          },
          dispatch: "static",
        });

        refs.push({
          from_symbol_id: symbol.id,
          to_symbol_id: calleeSym.id,
          site: {
            file_id: callerFileId,
            position: { line: siteLine + 1, column: siteCol + 1 },
          },
          kind: "call",
          confidence: "certain",
        });
      }
    }

    // Phase 4: Collect non-call references (type_ref, field_access, reference)
    const callRefKeys = new Set(
      refs.map((r) => `${r.to_symbol_id}@${r.site.file_id}:${r.site.position.line}:${r.site.position.column}`),
    );

    const refTargetSymbols = symbols
      .filter((s) => s.kind === "struct" || s.kind === "trait" || s.kind === "field" || s.kind === "variable" || s.kind === "constant" || s.kind === "enum")
      .map((s) => {
        const pos = s.decl.position;
        const rp = s.decl.file_id.replace(/^file:/, "");
        // pos is 1-based; convert to 0-based for LSP queries
        return { symbol: s, relPath: rp, line: pos.line - 1, col: pos.column - 1 };
      });

    for (const { symbol: targetSym, relPath: tRelPath, line: tLine, col: tCol } of refTargetSymbols) {
      let refLocs: Awaited<ReturnType<typeof client.references>>;
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
        const kind = targetSym.kind === "trait" || targetSym.kind === "struct"
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

    // Phase 5: Collect type relations (trait implementations)
    for (const { symbol, relPath, line, col } of traitSymbols) {
      let implLocs: Awaited<ReturnType<typeof client.implementation>>;
      try {
        implLocs = await client.implementation(relPath, line, col);
      } catch {
        continue;
      }

      for (const loc of implLocs) {
        const implRelPath = relative(repoRoot, LspClient.uriToPath(loc.uri));
        const implKey = `${implRelPath}:${loc.range.start.line}:${loc.range.start.character}`;
        let implSym = symbolByPos.get(implKey);

        if (!implSym) {
          // rust-analyzer returns the position in the impl declaration (e.g. "impl Greeter for Foo")
          // rather than the struct declaration. Fall back to name lookup.
          const content = fileContents.get(implRelPath);
          if (content) {
            const name = this.extractIdentifierAtPos(content, loc.range.start.line, loc.range.start.character);
            const candidates = symbolsByName.get(name) ?? [];
            implSym = candidates.find(
              (s) => s.decl.file_id === `file:${implRelPath}` && (s.kind === "struct" || s.kind === "enum"),
            );
          }
        }

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

  /**
   * Extract the identifier (word) at the given line:col position from file content.
   * Used to resolve impl declaration positions to struct names.
   */
  private extractIdentifierAtPos(content: string, line: number, col: number): string {
    const lines = content.split("\n");
    const lineContent = lines[line] ?? "";
    let start = col;
    let end = col;
    const isIdChar = (c: string) => /\w/.test(c);
    while (start > 0 && isIdChar(lineContent[start - 1]!)) start--;
    while (end < lineContent.length && isIdChar(lineContent[end]!)) end++;
    return lineContent.slice(start, end);
  }

  /**
   * Flatten hierarchical LSP document symbols into a flat list with position info.
   */
  private flattenDocumentSymbols(
    lspSyms: LspDocumentSymbol[],
    relPath: string,
    unitId: string,
    parentName?: string,
  ): Array<{ sym: Symbol; lspSym: LspDocumentSymbol }> {
    const result: Array<{ sym: Symbol; lspSym: LspDocumentSymbol }> = [];
    for (const lspSym of lspSyms) {
      const kind = this.mapSymbolKind(lspSym.kind);
      // Skip impl block symbols themselves — only include their children
      if (kind === "impl") {
        if (lspSym.children && lspSym.children.length > 0) {
          // Extract struct name from "impl Foo" or "impl Bar for Foo"
          const implMatch = /impl\s+(?:\w+\s+for\s+)?(\w+)/.exec(lspSym.name);
          const implParent = implMatch?.[1] ?? lspSym.name;
          result.push(...this.flattenDocumentSymbols(lspSym.children, relPath, unitId, implParent));
        }
        continue;
      }
      const sym = this.lspSymbolToSymbol(lspSym, relPath, unitId, parentName);
      result.push({ sym, lspSym });
      // Process children (fields within structs/traits)
      if (lspSym.children && lspSym.children.length > 0) {
        result.push(...this.flattenDocumentSymbols(lspSym.children, relPath, unitId, lspSym.name));
      }
    }
    return result;
  }

  private lspSymbolToSymbol(
    lspSym: LspDocumentSymbol,
    relPath: string,
    unitId: string,
    parentName?: string,
  ): Symbol {
    const kind = this.mapSymbolKind(lspSym.kind);
    const line = lspSym.selectionRange.start.line;
    const col = lspSym.selectionRange.start.character;
    const sigHash = hashSig(`${lspSym.name}:${lspSym.kind}:${line}`);
    const unitPath = unitId.replace(/^unit:rs:/, "");
    const name = parentName ? `${parentName}::${lspSym.name}` : lspSym.name;

    return {
      id: `sym:rs:${unitPath}#${kind}#${name}#sig:${sigHash}`,
      unit_id: unitId,
      name,
      kind,
      // Rust visibility requires `pub` keyword — default to true (conservative)
      exported: true,
      decl: {
        file_id: `file:${relPath}`,
        position: { line: line + 1, column: col + 1 },
      },
      metadata: parentName ? { receiver: parentName } : undefined,
    };
  }

  /**
   * Find the enclosing function/method symbol for a given file position.
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

  private mapSymbolKind(lspKind: number): string {
    const map: Record<number, string> = {
      2: "module",
      5: "struct",      // Class → struct in Rust
      6: "method",      // Method
      8: "field",       // Field
      10: "enum",       // Enum
      11: "trait",      // Interface → trait in Rust
      12: "function",   // Function
      13: "variable",   // Variable
      14: "constant",   // Constant
      19: "impl",       // Object → impl block in Rust
      22: "enum_member", // EnumMember (LSP spec §3.16)
      23: "struct",     // Struct (LSP spec §3.16)
    };
    return map[lspKind] ?? "unknown";
  }

  async diagnose(
    units: Unit[],
    _profile: Record<string, string>,
  ): Promise<Diagnostic[]> {
    const repoRoot = units[0]?.metadata?.["repo_root"] as string | undefined;
    if (!repoRoot) return [];

    const diagnostics: Diagnostic[] = [];

    // 1. cargo clippy (linting)
    if (await whichTool("cargo")) {
      const clippyResult = await exec(
        ["cargo", "clippy", "--message-format=json", "--quiet", "--", "-W", "clippy::all"],
        { cwd: repoRoot },
      );
      if (clippyResult.stdout) {
        diagnostics.push(...this.parseCargoJsonOutput(clippyResult.stdout, repoRoot, "clippy"));
      }
    }

    // 2. cargo check (compilation errors, if clippy failed)
    if (diagnostics.length === 0 && (await whichTool("cargo"))) {
      const checkResult = await exec(
        ["cargo", "check", "--message-format=json", "--quiet"],
        { cwd: repoRoot },
      );
      if (checkResult.stdout) {
        diagnostics.push(...this.parseCargoJsonOutput(checkResult.stdout, repoRoot, "cargo_check"));
      }
    }

    // 3. cargo audit (vulnerability scanning, optional)
    if (await whichTool("cargo-audit")) {
      const auditResult = await exec(
        ["cargo", "audit", "--json"],
        { cwd: repoRoot },
      );
      if (auditResult.stdout) {
        diagnostics.push(...this.parseCargoAuditOutput(auditResult.stdout));
      }
    }

    // 4. Circular dependency detection
    const allUnits = await this.enumerateUnits(repoRoot, _profile);
    const delta = await this.indexUnits(allUnits, _profile);
    if (delta.added.deps) {
      diagnostics.push(...detectCyclicDeps(delta.added.deps, "unit:rs:"));
    }

    return diagnostics;
  }

  // --- Private helpers ---

  private async cargoMetadata(repoRoot: string): Promise<CargoMetadata | null> {
    const result = await exec(
      ["cargo", "metadata", "--format-version=1", "--no-deps"],
      { cwd: repoRoot },
    );
    if (result.exitCode !== 0) return null;
    try {
      return JSON.parse(result.stdout) as CargoMetadata;
    } catch {
      return null;
    }
  }

  private parseCargoJsonOutput(output: string, repoRoot: string, tool: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.reason !== "compiler-message") continue;
        const diag = msg.message;
        if (!diag?.spans?.length) continue;

        const primarySpan = diag.spans.find((s: any) => s.is_primary) ?? diag.spans[0];
        if (!primarySpan?.file_name) continue;

        const relPath = relative(repoRoot, resolve(repoRoot, primarySpan.file_name));
        if (relPath.startsWith("..")) continue;

        const severity = diag.level === "error" ? "error" as const
          : diag.level === "warning" ? "warning" as const
          : diag.level === "note" ? "info" as const
          : "info" as const;

        diagnostics.push({
          file_id: `file:${relPath}`,
          position: {
            line: primarySpan.line_start ?? 1,
            column: primarySpan.column_start ?? 1,
          },
          severity,
          message: `${diag.code?.code ?? tool}: ${diag.message}`,
          tool,
        });
      } catch { /* skip malformed lines */ }
    }
    return diagnostics;
  }

  private parseCargoAuditOutput(output: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    try {
      const data = JSON.parse(output);
      for (const vuln of data.vulnerabilities?.list ?? []) {
        const advisory = vuln.advisory;
        if (!advisory) continue;
        diagnostics.push({
          file_id: "file:Cargo.toml",
          position: { line: 1, column: 1 },
          severity: "error",
          message: `${advisory.id}: ${advisory.title} (package: ${vuln.package?.name ?? "unknown"})`,
          tool: "cargo_audit",
        });
      }
    } catch { /* ignore malformed JSON */ }
    return diagnostics;
  }
}

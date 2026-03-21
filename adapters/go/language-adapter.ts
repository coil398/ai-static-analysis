// GoLanguageAdapter — GO_SPEC.md §2-7, SPEC.md §8.1

import { resolve, relative } from "node:path";
import type {
  LanguageAdapter,
  DetectResult,
  DoctorResult,
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
  type GoplsSymbol,
} from "./gopls.ts";

export class GoLanguageAdapter implements LanguageAdapter {
  readonly lang = "go";

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

    const goplsPath = await whichTool("gopls");
    if (!goplsPath) {
      notes.push("gopls not found (optional, needed for symbols/refs)");
    } else {
      const ver = await exec(["gopls", "version"]);
      if (ver.exitCode === 0) notes.push(`gopls: ${ver.stdout.split("\n")[0]}`);
    }

    return { ok: missing.length === 0, missing_tools: missing, notes };
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
        allGoFiles.push({ absPath, relPath, unitId: unit.id });
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

    if (hasGopls) {
      const result = await this.indexWithGopls(
        repoRoot,
        allGoFiles,
        unitIds,
      );
      symbols = result.symbols;
      refs = result.refs;
      typeRelations = result.typeRelations;
      callEdges = result.callEdges;
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
      const goplsSyms = await goplsSymbols(relPath, repoRoot);

      for (const gSym of goplsSyms) {
        const sym = this.goplsSymbolToSymbol(gSym, relPath, unitId);
        symbols.push(sym);
        symbolByPos.set(`${relPath}:${gSym.line}:${gSym.startCol}`, sym);

        if (gSym.kind === "Interface" || gSym.kind === "Struct") {
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
      const hierarchy = await goplsCallHierarchy(relPath, line, col, repoRoot);
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

    // 3. Collect type relations (implementations)
    for (const { symbol, relPath, line, col } of interfaceSymbols) {
      if (symbol.kind !== "interface") continue;

      const impls = await goplsImplementation(relPath, line, col, repoRoot);
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

    const result = await exec(["go", "vet", "./..."], { cwd: repoRoot });
    if (result.exitCode === 0 && !result.stderr) return [];

    return parseVetOutput(result.stderr, repoRoot);
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

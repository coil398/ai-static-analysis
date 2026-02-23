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
  FactsDelta,
  Diagnostic,
} from "../../core/schema/types.ts";
import { exec, whichTool, hashFile, isGenerated } from "./utils.ts";
import { goList, type GoPackage } from "./go-list.ts";

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
    // We need repoRoot to run go list; extract from unit metadata
    const repoRoot = units[0]?.metadata?.["repo_root"] as string | undefined;
    if (!repoRoot) {
      throw new Error("units must contain repo_root in metadata");
    }

    const packages = await goList(repoRoot, profile);
    const pkgByImportPath = new Map<string, GoPackage>();
    for (const p of packages) {
      pkgByImportPath.set(p.ImportPath, p);
    }

    // Determine module path for filtering deps
    const modulePath = packages[0]?.Module?.Path;

    const unitIds = new Set(units.map((u) => u.id));
    const files: File[] = [];
    const deps: Dep[] = [];

    for (const unit of units) {
      const importPath = unit.metadata?.["import_path"] as string | undefined;
      const pkg = importPath ? pkgByImportPath.get(importPath) : undefined;
      if (!pkg) continue;

      // Files
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

    return {
      added: {
        units,
        files,
        deps,
        symbols: [],
        refs: [],
        type_relations: [],
        call_edges: [],
      },
      removed: {},
    };
  }

  async diagnose(
    units: Unit[],
    _profile: Record<string, string>,
  ): Promise<Diagnostic[]> {
    const repoRoot = units[0]?.metadata?.["repo_root"] as string | undefined;
    if (!repoRoot) return [];

    const result = await exec(["go", "vet", "./..."], { cwd: repoRoot });
    // go vet outputs to stderr
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
  // pattern: path.go:line:col: message  OR  path.go:line: message
  const re = /^(.+?):(\d+):(?:(\d+):)?\s*(.+)$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip lines like "# example.com/testproject/pkg"
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

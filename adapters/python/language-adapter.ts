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
    const tools = ["ruff", "mypy", "bandit", "pytest"];

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

    return {
      added: { units, files, deps, symbols: [] },
      removed: {},
    };
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

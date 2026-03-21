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
} from "../shared/index.ts";

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

    const tools = ["typescript", "eslint", "prettier"];
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
    const symbols: Symbol[] = [];
    const unitIds = new Set(units.map((u) => u.id));

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
      added: { units, files, deps, symbols },
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

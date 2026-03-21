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

    // 2. Circular dependency detection
    const allUnits = await this.enumerateUnits(repoRoot, _profile);
    const delta = await this.indexUnits(allUnits, _profile);
    if (delta.added.deps) {
      diagnostics.push(...detectCyclicDeps(delta.added.deps, "unit:cs:"));
    }

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

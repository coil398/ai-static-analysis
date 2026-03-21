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
      for (const component of ["clippy", "rustfmt"]) {
        if (component === "clippy" && (await whichTool("clippy-driver"))) {
          notes.push(`${component}: already installed`);
          continue;
        }
        if (component === "rustfmt" && (await whichTool("rustfmt"))) {
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
        const result = await exec(["cargo", "install", pkg]);
        if (result.exitCode === 0) {
          installed.push(name);
        } else {
          failed.push({ tool: name, reason: result.stderr });
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

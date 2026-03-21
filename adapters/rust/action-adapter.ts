// RustActionAdapter — RUST_SPEC.md

import type {
  ActionAdapter,
  ActionResult,
  Scope,
} from "../../core/adapter/types.ts";
import { exec } from "../shared/index.ts";

export class RustActionAdapter implements ActionAdapter {
  readonly lang = "rust";

  async format(
    repoRoot: string,
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    switch (scope.kind) {
      case "repo":
        return this.run(["cargo", "fmt", "--all"], repoRoot);
      case "unit": {
        const path = scope.unitId.replace(/^unit:rs:/, "");
        const pkg = path === "." ? [] : ["-p", path];
        return this.run(["cargo", "fmt", ...pkg], repoRoot);
      }
      case "files":
        return this.run(["rustfmt", ...scope.paths], repoRoot);
      case "paths":
        return this.run(["rustfmt", ...scope.globs], repoRoot);
    }
  }

  async check(
    repoRoot: string,
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const pkgArgs = this.scopeToPkgArgs(scope);

    // Prefer clippy, fallback to cargo check
    const clippy = await this.run(
      ["cargo", "clippy", ...pkgArgs, "--", "-D", "warnings"],
      repoRoot,
    );
    return clippy;
  }

  async test(
    repoRoot: string,
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const pkgArgs = this.scopeToPkgArgs(scope);
    return this.run(["cargo", "test", ...pkgArgs], repoRoot);
  }

  private async run(cmd: string[], cwd: string): Promise<ActionResult> {
    const result = await exec(cmd, { cwd });
    return {
      ok: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode,
    };
  }

  private scopeToPkgArgs(scope: Scope): string[] {
    switch (scope.kind) {
      case "repo":
        return ["--workspace"];
      case "unit": {
        const path = scope.unitId.replace(/^unit:rs:/, "");
        return path === "." ? [] : ["-p", path];
      }
      case "files":
      case "paths":
        return [];
    }
  }
}

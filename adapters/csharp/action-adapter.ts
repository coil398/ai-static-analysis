// CSharpActionAdapter — CSHARP_SPEC.md

import type {
  ActionAdapter,
  ActionResult,
  Scope,
} from "../../core/adapter/types.ts";
import { exec } from "../shared/index.ts";

export class CSharpActionAdapter implements ActionAdapter {
  readonly lang = "csharp";

  async format(
    repoRoot: string,
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const targets = this.scopeToTargets(scope);
    // dotnet format works at solution/project level
    if (targets.length === 1 && targets[0] === ".") {
      return this.run(["dotnet", "format"], repoRoot);
    }
    return this.run(["dotnet", "format", ...targets], repoRoot);
  }

  async check(
    repoRoot: string,
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const targets = this.scopeToTargets(scope);
    // dotnet build for compilation check
    const build = await this.run(
      ["dotnet", "build", "--no-restore", ...targets],
      repoRoot,
    );
    return build;
  }

  async test(
    repoRoot: string,
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const targets = this.scopeToTargets(scope);
    return this.run(
      ["dotnet", "test", "--no-build", ...targets],
      repoRoot,
    );
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

  private scopeToTargets(scope: Scope): string[] {
    switch (scope.kind) {
      case "repo":
        return ["."];
      case "unit": {
        const path = scope.unitId.replace(/^unit:cs:/, "");
        return [path === "." ? "." : `./${path}`];
      }
      case "files":
        return scope.paths;
      case "paths":
        return scope.globs;
    }
  }
}

// GoActionAdapter — GO_SPEC.md §8, SPEC.md §8.2

import type {
  ActionAdapter,
  ActionResult,
  Scope,
} from "../../core/adapter/types.ts";
import { exec } from "./utils.ts";

export class GoActionAdapter implements ActionAdapter {
  readonly lang = "go";

  async format(
    repoRoot: string,
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const targets = this.scopeToGoTargets(scope);
    return this.run(["go", "fmt", ...targets], repoRoot);
  }

  async check(
    repoRoot: string,
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const targets = this.scopeToGoTargets(scope);

    // Run go build first
    const build = await this.run(["go", "build", ...targets], repoRoot);
    if (!build.ok) return build;

    // Then go vet
    const vet = await this.run(["go", "vet", ...targets], repoRoot);
    return {
      ok: vet.ok,
      stdout: [build.stdout, vet.stdout].filter(Boolean).join("\n"),
      stderr: [build.stderr, vet.stderr].filter(Boolean).join("\n"),
      exit_code: vet.exit_code,
    };
  }

  async test(
    repoRoot: string,
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const targets = this.scopeToGoTargets(scope);
    return this.run(["go", "test", ...targets], repoRoot);
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

  private scopeToGoTargets(scope: Scope): string[] {
    switch (scope.kind) {
      case "repo":
        return ["./..."];
      case "unit": {
        // unitId format: "unit:go:<path>" — extract path part
        const parts = scope.unitId.split(":");
        const path = parts.slice(2).join(":");
        return [`./${path}/...`];
      }
      case "files":
        return scope.paths;
      case "paths":
        return scope.globs;
    }
  }
}

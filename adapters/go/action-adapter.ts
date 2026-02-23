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
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    // Use `go fmt` instead of `gofmt` directly — more portable
    const targets = this.scopeToGoTargets(scope);
    return this.run(["go", "fmt", ...targets], scope);
  }

  async check(
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const targets = this.scopeToGoTargets(scope);

    // Run go build first
    const build = await this.run(["go", "build", ...targets], scope);
    if (!build.ok) return build;

    // Then go vet
    const vet = await this.run(["go", "vet", ...targets], scope);
    return {
      ok: vet.ok,
      stdout: [build.stdout, vet.stdout].filter(Boolean).join("\n"),
      stderr: [build.stderr, vet.stderr].filter(Boolean).join("\n"),
      exit_code: vet.exit_code,
    };
  }

  async test(
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const targets = this.scopeToGoTargets(scope);
    return this.run(["go", "test", ...targets], scope);
  }

  private async run(cmd: string[], scope: Scope): Promise<ActionResult> {
    const cwd = this.scopeToCwd(scope);
    const result = await exec(cmd, cwd ? { cwd } : undefined);
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
      case "unit":
        return [`./${scope.unitId}/...`];
      case "files":
        return scope.paths;
      case "paths":
        return scope.globs;
    }
  }

  private scopeToCwd(scope: Scope): string | undefined {
    // For unit scope, the unitId might encode the repo root info
    // For now, return undefined (caller should set cwd appropriately)
    return undefined;
  }
}

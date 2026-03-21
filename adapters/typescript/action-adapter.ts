// TypeScriptActionAdapter — TS_SPEC.md

import type {
  ActionAdapter,
  ActionResult,
  Scope,
} from "../../core/adapter/types.ts";
import { exec, whichTool } from "../shared/index.ts";

export class TypeScriptActionAdapter implements ActionAdapter {
  readonly lang = "typescript";

  async format(
    repoRoot: string,
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const targets = this.scopeToTargets(scope);

    // Prefer prettier, fallback to biome
    if (await whichTool("prettier")) {
      return this.run(["prettier", "--write", ...targets], repoRoot);
    }
    if (await whichTool("biome")) {
      return this.run(["biome", "format", "--write", ...targets], repoRoot);
    }
    return {
      ok: false,
      stdout: "",
      stderr: "No formatter found (install prettier or biome)",
      exit_code: 1,
    };
  }

  async check(
    repoRoot: string,
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const results: ActionResult[] = [];

    // 1. tsc type checking
    const tscCmd = (await whichTool("tsc"))
      ? ["tsc", "--noEmit"]
      : ["npx", "--no-install", "tsc", "--noEmit"];
    const tsc = await this.run(tscCmd, repoRoot);
    results.push(tsc);

    // 2. eslint (optional)
    if (await whichTool("eslint")) {
      const targets = this.scopeToTargets(scope);
      const eslint = await this.run(["eslint", ...targets], repoRoot);
      results.push(eslint);
    }

    return this.mergeResults(results);
  }

  async test(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    // Detect test runner: vitest > jest > npm test
    if (await whichTool("vitest")) {
      return this.run(["vitest", "run"], repoRoot);
    }
    if (await whichTool("jest")) {
      return this.run(["jest"], repoRoot);
    }
    // Fallback to npm test
    return this.run(["npm", "test", "--if-present"], repoRoot);
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
        const path = scope.unitId.replace(/^unit:ts:/, "");
        return [path === "." ? "." : `./${path}`];
      }
      case "files":
        return scope.paths;
      case "paths":
        return scope.globs;
    }
  }

  private mergeResults(results: ActionResult[]): ActionResult {
    const ok = results.every((r) => r.ok);
    return {
      ok,
      stdout: results.map((r) => r.stdout).filter(Boolean).join("\n"),
      stderr: results.map((r) => r.stderr).filter(Boolean).join("\n"),
      exit_code: ok ? 0 : results.find((r) => !r.ok)?.exit_code ?? 1,
    };
  }
}

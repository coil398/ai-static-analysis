// PythonActionAdapter — PYTHON_SPEC.md

import type {
  ActionAdapter,
  ActionResult,
  Scope,
} from "../../core/adapter/types.ts";
import { exec, whichTool } from "../shared/index.ts";

export class PythonActionAdapter implements ActionAdapter {
  readonly lang = "python";

  async format(
    repoRoot: string,
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const targets = this.scopeToTargets(scope);

    // Prefer ruff format, fallback to black
    if (await whichTool("ruff")) {
      return this.run(["ruff", "format", ...targets], repoRoot);
    }
    if (await whichTool("black")) {
      return this.run(["black", ...targets], repoRoot);
    }
    return {
      ok: false,
      stdout: "",
      stderr: "No formatter found (install ruff or black)",
      exit_code: 1,
    };
  }

  async check(
    repoRoot: string,
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const targets = this.scopeToTargets(scope);
    const results: ActionResult[] = [];

    // 1. ruff check or flake8
    if (await whichTool("ruff")) {
      results.push(await this.run(["ruff", "check", ...targets], repoRoot));
    } else if (await whichTool("flake8")) {
      results.push(await this.run(["flake8", ...targets], repoRoot));
    }

    // 2. mypy (optional)
    if (await whichTool("mypy")) {
      results.push(await this.run(["mypy", ...targets], repoRoot));
    }

    if (results.length === 0) {
      return {
        ok: false,
        stdout: "",
        stderr: "No linter found (install ruff or flake8)",
        exit_code: 1,
      };
    }

    return this.mergeResults(results);
  }

  async test(
    repoRoot: string,
    scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const targets = this.scopeToTargets(scope);

    if (await whichTool("pytest")) {
      return this.run(["pytest", ...targets], repoRoot);
    }
    // Fallback to unittest
    const py = (await whichTool("python3")) ? "python3" : "python";
    return this.run([py, "-m", "unittest", "discover", ...targets], repoRoot);
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
        const path = scope.unitId.replace(/^unit:py:/, "");
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

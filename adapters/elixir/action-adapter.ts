// ElixirActionAdapter — ELIXIR_SPEC.md

import type {
  ActionAdapter,
  ActionResult,
  Scope,
} from "../../core/adapter/types.ts";
import { exec, whichTool } from "../shared/index.ts";

export class ElixirActionAdapter implements ActionAdapter {
  readonly lang = "elixir";

  async format(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    if (await whichTool("mix")) {
      return this.run(["mix", "format"], repoRoot);
    }
    return {
      ok: false,
      stdout: "",
      stderr: "mix not found.",
      exit_code: 1,
    };
  }

  async check(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    if (await whichTool("mix")) {
      return this.run(["mix", "compile", "--warnings-as-errors"], repoRoot);
    }
    return {
      ok: false,
      stdout: "",
      stderr: "mix not found.",
      exit_code: 1,
    };
  }

  async test(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    if (await whichTool("mix")) {
      return this.run(["mix", "test"], repoRoot);
    }
    return {
      ok: false,
      stdout: "",
      stderr: "mix not found.",
      exit_code: 1,
    };
  }

  private async run(cmd: string[], cwd: string): Promise<ActionResult> {
    const r = await exec(cmd, { cwd });
    return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exit_code: r.exitCode };
  }
}

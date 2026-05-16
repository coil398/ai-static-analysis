// HaskellActionAdapter — HASKELL_SPEC.md

import { resolve } from "node:path";
import type {
  ActionAdapter,
  ActionResult,
  Scope,
} from "../../core/adapter/types.ts";
import { exec, whichTool } from "../shared/index.ts";

export class HaskellActionAdapter implements ActionAdapter {
  readonly lang = "haskell";

  async format(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const formatter =
      (await whichTool("fourmolu")) ? "fourmolu" :
      (await whichTool("ormolu")) ? "ormolu" :
      null;
    if (!formatter) {
      return {
        ok: false,
        stdout: "",
        stderr: "No Haskell formatter found (install fourmolu or ormolu).",
        exit_code: 1,
      };
    }
    return this.run(
      ["sh", "-c", `find . \\( -name '*.hs' -o -name '*.lhs' \\) -not -path './dist*/*' -print0 | xargs -0 ${formatter} -i`],
      repoRoot,
    );
  }

  async check(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    if (await whichTool("cabal")) {
      return this.run(["cabal", "build", "all"], repoRoot);
    }
    if (await whichTool("stack")) {
      return this.run(["stack", "build"], repoRoot);
    }
    return {
      ok: false,
      stdout: "",
      stderr: "Neither cabal nor stack is installed.",
      exit_code: 1,
    };
  }

  async test(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    if (await whichTool("cabal")) {
      return this.run(["cabal", "test", "all"], repoRoot);
    }
    if (await whichTool("stack")) {
      return this.run(["stack", "test"], repoRoot);
    }
    return {
      ok: false,
      stdout: "",
      stderr: "Neither cabal nor stack is installed.",
      exit_code: 1,
    };
  }

  private async run(cmd: string[], cwd: string): Promise<ActionResult> {
    const r = await exec(cmd, { cwd });
    return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exit_code: r.exitCode };
  }
}

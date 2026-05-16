// ClojureActionAdapter — CLOJURE_SPEC.md

import { resolve } from "node:path";
import type {
  ActionAdapter,
  ActionResult,
  Scope,
} from "../../core/adapter/types.ts";
import { exec, whichTool } from "../shared/index.ts";

export class ClojureActionAdapter implements ActionAdapter {
  readonly lang = "clojure";

  async format(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    if (await whichTool("cljfmt")) {
      return this.run(["cljfmt", "fix"], repoRoot);
    }
    if (await whichTool("zprint")) {
      return this.run(
        ["sh", "-c", "find . -name '*.clj*' -not -path './target/*' -print0 | xargs -0 -n1 zprint -w"],
        repoRoot,
      );
    }
    return {
      ok: false,
      stdout: "",
      stderr: "No Clojure formatter found (install cljfmt or zprint).",
      exit_code: 1,
    };
  }

  async check(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    if (await whichTool("clj-kondo")) {
      return this.run(["clj-kondo", "--lint", "."], repoRoot);
    }
    if (await whichTool("clojure")) {
      return this.run(["clojure", "-M:check"], repoRoot);
    }
    if (await whichTool("lein")) {
      return this.run(["lein", "check"], repoRoot);
    }
    return {
      ok: false,
      stdout: "",
      stderr: "No Clojure linter / build tool found.",
      exit_code: 1,
    };
  }

  async test(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    if (await Bun.file(resolve(repoRoot, "deps.edn")).exists()) {
      if (await whichTool("clojure")) {
        return this.run(["clojure", "-X:test"], repoRoot);
      }
    }
    if (await Bun.file(resolve(repoRoot, "project.clj")).exists() && await whichTool("lein")) {
      return this.run(["lein", "test"], repoRoot);
    }
    return {
      ok: false,
      stdout: "",
      stderr: "No Clojure test driver detected.",
      exit_code: 1,
    };
  }

  private async run(cmd: string[], cwd: string): Promise<ActionResult> {
    const r = await exec(cmd, { cwd });
    return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exit_code: r.exitCode };
  }
}

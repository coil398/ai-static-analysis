// CppActionAdapter — CPP_SPEC.md

import { resolve } from "node:path";
import type {
  ActionAdapter,
  ActionResult,
  Scope,
} from "../../core/adapter/types.ts";
import { exec, whichTool } from "../shared/index.ts";

export class CppActionAdapter implements ActionAdapter {
  readonly lang = "cpp";

  async format(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    if (!(await whichTool("clang-format"))) {
      return {
        ok: false,
        stdout: "",
        stderr: "clang-format not found.",
        exit_code: 1,
      };
    }
    return this.run(
      [
        "sh",
        "-c",
        "find . \\( -name '*.cpp' -o -name '*.cc' -o -name '*.cxx' -o -name '*.hpp' -o -name '*.h' -o -name '*.hh' \\) -not -path './build*/*' -print0 | xargs -0 clang-format -i",
      ],
      repoRoot,
    );
  }

  async check(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    if (await whichTool("cmake")) {
      const buildDir = "build";
      if (await Bun.file(resolve(repoRoot, buildDir, "CMakeCache.txt")).exists()) {
        return this.run(["cmake", "--build", buildDir, "--target", "all"], repoRoot);
      }
      return this.run(
        ["sh", "-c", "cmake -B build -S . && cmake --build build"],
        repoRoot,
      );
    }
    if (await Bun.file(resolve(repoRoot, "Makefile")).exists()) {
      return this.run(["make"], repoRoot);
    }
    return {
      ok: false,
      stdout: "",
      stderr: "Neither CMakeLists.txt nor Makefile detected.",
      exit_code: 1,
    };
  }

  async test(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    if (await whichTool("ctest")) {
      return this.run(["ctest", "--test-dir", "build", "--output-on-failure"], repoRoot);
    }
    if (await Bun.file(resolve(repoRoot, "Makefile")).exists()) {
      return this.run(["make", "test"], repoRoot);
    }
    return {
      ok: false,
      stdout: "",
      stderr: "ctest / make test not available.",
      exit_code: 1,
    };
  }

  private async run(cmd: string[], cwd: string): Promise<ActionResult> {
    const r = await exec(cmd, { cwd });
    return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exit_code: r.exitCode };
  }
}

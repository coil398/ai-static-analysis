// JavaActionAdapter — JAVA_SPEC.md
//
// Drives the build/test tool that the project already declares (Gradle or
// Maven). The adapter does NOT try to introduce a new build system.

import { resolve } from "node:path";
import type {
  ActionAdapter,
  ActionResult,
  Scope,
} from "../../core/adapter/types.ts";
import { exec, whichTool } from "../shared/index.ts";

export class JavaActionAdapter implements ActionAdapter {
  readonly lang = "java";

  async format(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    // Prefer google-java-format if present; fall back to gradle spotlessApply
    // (when configured) or maven spotless:apply.
    if (await whichTool("google-java-format")) {
      // Format every .java file in-place. The CLI doesn't accept globs, so we
      // shell out via xargs.
      const cmd = [
        "sh",
        "-c",
        "find . -name '*.java' -not -path './build/*' -not -path './target/*' -print0 | xargs -0 google-java-format -i",
      ];
      return this.run(cmd, repoRoot);
    }
    const buildTool = await detectBuildTool(repoRoot);
    if (buildTool === "gradle") {
      return this.run(["gradle", "spotlessApply"], repoRoot);
    }
    if (buildTool === "maven") {
      return this.run(["mvn", "spotless:apply"], repoRoot);
    }
    return {
      ok: false,
      stdout: "",
      stderr:
        "No Java formatter found (install google-java-format, or configure spotless in Gradle/Maven).",
      exit_code: 1,
    };
  }

  async check(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const buildTool = await detectBuildTool(repoRoot);
    if (buildTool === "gradle") {
      return this.run(["gradle", "check"], repoRoot);
    }
    if (buildTool === "maven") {
      return this.run(["mvn", "verify"], repoRoot);
    }
    return {
      ok: false,
      stdout: "",
      stderr: "No Gradle / Maven configuration detected.",
      exit_code: 1,
    };
  }

  async test(
    repoRoot: string,
    _scope: Scope,
    _profile: Record<string, string>,
  ): Promise<ActionResult> {
    const buildTool = await detectBuildTool(repoRoot);
    if (buildTool === "gradle") {
      return this.run(["gradle", "test"], repoRoot);
    }
    if (buildTool === "maven") {
      return this.run(["mvn", "test"], repoRoot);
    }
    return {
      ok: false,
      stdout: "",
      stderr: "No Gradle / Maven configuration detected.",
      exit_code: 1,
    };
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
}

async function detectBuildTool(
  repoRoot: string,
): Promise<"gradle" | "maven" | null> {
  for (const f of ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]) {
    if (await Bun.file(resolve(repoRoot, f)).exists()) return "gradle";
  }
  if (await Bun.file(resolve(repoRoot, "pom.xml")).exists()) return "maven";
  return null;
}

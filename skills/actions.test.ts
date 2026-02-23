import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { runAction } from "./actions.ts";

const TESTDATA = resolve(
  import.meta.dir,
  "../adapters/go/testdata",
);

describe("runAction", () => {
  test("check action runs on Go testdata", async () => {
    const result = await runAction({
      repoRoot: TESTDATA,
      action: "check",
      scope: { kind: "repo" },
    });

    expect(result.errors).toHaveLength(0);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.lang).toBe("go");
    expect(result.results[0]!.action).toBe("check");
  });

  test("format action runs on Go testdata", async () => {
    const result = await runAction({
      repoRoot: TESTDATA,
      action: "format",
      scope: { kind: "files", paths: [resolve(TESTDATA, "main.go")] },
    });

    expect(result.errors).toHaveLength(0);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.result.ok).toBe(true);
  });

  test("test action runs on Go testdata", async () => {
    const result = await runAction({
      repoRoot: TESTDATA,
      action: "test",
      scope: { kind: "repo" },
    });

    expect(result.errors).toHaveLength(0);
    expect(result.results.length).toBeGreaterThan(0);
  });

  test("returns no results for unsupported repo", async () => {
    const result = await runAction({
      repoRoot: "/tmp",
      action: "check",
      scope: { kind: "repo" },
    });

    expect(result.results).toHaveLength(0);
    expect(result.ok).toBe(true);
  });
});

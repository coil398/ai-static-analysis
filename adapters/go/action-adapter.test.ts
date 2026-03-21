import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { GoActionAdapter } from "./action-adapter.ts";

const TESTDATA = resolve(import.meta.dir, "testdata");

describe("GoActionAdapter", () => {
  const adapter = new GoActionAdapter();

  test("format with repo scope runs from repoRoot", async () => {
    const result = await adapter.format(TESTDATA, { kind: "repo" }, {});
    expect(result.ok).toBe(true);
    expect(result.exit_code).toBe(0);
  });

  test("format with files scope targets specific files", async () => {
    const result = await adapter.format(
      TESTDATA,
      { kind: "files", paths: [resolve(TESTDATA, "main.go")] },
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.exit_code).toBe(0);
  });

  test("check runs go build + go vet", async () => {
    const result = await adapter.check(TESTDATA, { kind: "repo" }, {});
    expect(result.ok).toBe(true);
    expect(result.exit_code).toBe(0);
  });

  test("check with unit scope targets a package", async () => {
    const result = await adapter.check(
      TESTDATA,
      { kind: "unit", unitId: "unit:go:pkg" },
      {},
    );
    expect(result.ok).toBe(true);
    expect(result.exit_code).toBe(0);
  });

  test("test runs go test", async () => {
    const result = await adapter.test(TESTDATA, { kind: "repo" }, {});
    expect(result.ok).toBe(true);
    expect(result.exit_code).toBe(0);
  });
});

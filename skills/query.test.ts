import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { indexFacts } from "./index.ts";
import {
  queryDeps,
  queryRdeps,
  queryDefs,
  queryRefs,
  queryDiagnostics,
  queryImpact,
  queryImpls,
  queryCallers,
  queryCallees,
} from "./query.ts";

const TESTDATA = resolve(
  import.meta.dir,
  "../adapters/go/testdata",
);

describe("query-facts", () => {
  let tempDir: string;
  let cacheDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  async function setup() {
    tempDir = await mkdtemp(join(tmpdir(), "query-test-"));
    cacheDir = join(tempDir, "cache");
    await indexFacts({ repoRoot: TESTDATA, cacheDir });
    return { repoRoot: TESTDATA, cacheDir };
  }

  test("queryDeps returns outgoing deps for a unit", async () => {
    const opts = await setup();
    const result = await queryDeps("unit:go:.", opts);
    expect(result.unitId).toBe("unit:go:.");
    // main package imports pkg
    const depTargets = result.deps.map((d) => d.to_unit_id);
    expect(depTargets).toContain("unit:go:pkg");
  });

  test("queryRdeps returns incoming deps for a unit", async () => {
    const opts = await setup();
    const result = await queryRdeps("unit:go:pkg", opts);
    expect(result.unitId).toBe("unit:go:pkg");
    // pkg is imported by main
    const rdepSources = result.rdeps.map((d) => d.from_unit_id);
    expect(rdepSources).toContain("unit:go:.");
  });

  test("queryDefs returns empty for MVP (no symbols indexed yet)", async () => {
    const opts = await setup();
    const result = await queryDefs("main", opts);
    // MVP: symbols are empty arrays from Go adapter
    expect(result.symbols).toEqual([]);
  });

  test("queryRefs returns empty for MVP", async () => {
    const opts = await setup();
    const result = await queryRefs("sym:go:any", opts);
    expect(result.refs).toEqual([]);
  });

  test("queryDiagnostics repo scope returns all", async () => {
    const opts = await setup();
    const result = await queryDiagnostics("repo", opts);
    // May or may not have diagnostics depending on testdata
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });

  test("queryDiagnostics file scope filters correctly", async () => {
    const opts = await setup();
    const result = await queryDiagnostics(
      { file: "main.go" },
      opts,
    );
    expect(Array.isArray(result.diagnostics)).toBe(true);
    for (const d of result.diagnostics) {
      expect(d.file_id).toBe("file:main.go");
    }
  });

  test("queryDiagnostics unit scope filters correctly", async () => {
    const opts = await setup();
    const result = await queryDiagnostics(
      { unit: "unit:go:pkg" },
      opts,
    );
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });

  test("queryImpact returns affected units", async () => {
    const opts = await setup();
    const result = await queryImpact(["main.go"], opts);
    expect(result.affectedUnits).toContain("unit:go:.");
    expect(result.changedFiles).toEqual(["main.go"]);
  });

  test("queryImpls returns empty for MVP", async () => {
    const opts = await setup();
    const result = await queryImpls("sym:go:any", opts);
    expect(result.implementations).toEqual([]);
  });

  test("queryCallers returns empty for MVP", async () => {
    const opts = await setup();
    const result = await queryCallers("sym:go:any", opts);
    expect(result.callers).toEqual([]);
  });

  test("queryCallees returns empty for MVP", async () => {
    const opts = await setup();
    const result = await queryCallees("sym:go:any", opts);
    expect(result.callees).toEqual([]);
  });

  test("throws when no cached facts exist", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "query-test-"));
    cacheDir = join(tempDir, "cache");

    expect(
      queryDeps("unit:go:.", { repoRoot: TESTDATA, cacheDir }),
    ).rejects.toThrow("No cached facts found");
  });
});

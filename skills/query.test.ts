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
  queryDeadCode,
  clearFactsCache,
} from "./query.ts";
import { whichTool } from "../adapters/go/utils.ts";

const hasGopls = await whichTool("gopls") !== null;

const TESTDATA = resolve(
  import.meta.dir,
  "../adapters/go/testdata",
);

describe("query-facts", () => {
  let tempDir: string;
  let cacheDir: string;

  afterEach(async () => {
    clearFactsCache();
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
    const depTargets = result.deps.map((d) => d.to_unit_id);
    expect(depTargets).toContain("unit:go:pkg");
  }, 30_000);

  test("queryRdeps returns incoming deps for a unit", async () => {
    const opts = await setup();
    const result = await queryRdeps("unit:go:pkg", opts);
    expect(result.unitId).toBe("unit:go:pkg");
    const rdepSources = result.rdeps.map((d) => d.from_unit_id);
    expect(rdepSources).toContain("unit:go:.");
  }, 30_000);

  test.skipIf(!hasGopls)("queryDefs returns symbols matching name", async () => {
    const opts = await setup();
    const result = await queryDefs("NewService", opts);
    expect(result.symbols.length).toBeGreaterThan(0);
    expect(result.symbols[0]!.name).toBe("NewService");
  }, 30_000);

  test.skipIf(!hasGopls)("queryRefs returns refs for a symbol", async () => {
    const opts = await setup();
    // First find a symbol ID
    const defs = await queryDefs("NewService", opts);
    expect(defs.symbols.length).toBeGreaterThan(0);
    const symId = defs.symbols[0]!.id;

    const result = await queryRefs(symId, opts);
    // NewService is called from main, so refs should exist
    expect(result.refs.length).toBeGreaterThan(0);
    expect(result.refs[0]!.to_symbol_id).toBe(symId);
  }, 30_000);

  test("queryDiagnostics repo scope returns all", async () => {
    const opts = await setup();
    const result = await queryDiagnostics("repo", opts);
    expect(Array.isArray(result.diagnostics)).toBe(true);
  }, 30_000);

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
  }, 30_000);

  test("queryDiagnostics unit scope filters correctly", async () => {
    const opts = await setup();
    const result = await queryDiagnostics(
      { unit: "unit:go:pkg" },
      opts,
    );
    expect(Array.isArray(result.diagnostics)).toBe(true);
  }, 30_000);

  test("queryImpact returns affected units", async () => {
    const opts = await setup();
    const result = await queryImpact(["main.go"], opts);
    expect(result.affectedUnits).toContain("unit:go:.");
    expect(result.changedFiles).toEqual(["main.go"]);
  }, 30_000);

  test.skipIf(!hasGopls)("queryImpls returns implementations", async () => {
    const opts = await setup();
    // Find Storer interface symbol
    const defs = await queryDefs("Storer", opts);
    expect(defs.symbols.length).toBeGreaterThan(0);
    const symId = defs.symbols[0]!.id;

    const result = await queryImpls(symId, opts);
    // Store implements Storer
    expect(result.implementations.length).toBeGreaterThan(0);
    expect(result.implementations[0]!.from_type_id).toContain("Store");
  }, 30_000);

  test.skipIf(!hasGopls)("queryCallers returns callers of a function", async () => {
    const opts = await setup();
    const defs = await queryDefs("NewService", opts);
    expect(defs.symbols.length).toBeGreaterThan(0);
    const symId = defs.symbols[0]!.id;

    const result = await queryCallers(symId, opts);
    // main calls NewService
    expect(result.callers.length).toBeGreaterThan(0);
    expect(result.callers[0]!.caller_id).toContain("main");
  }, 30_000);

  test.skipIf(!hasGopls)("queryCallees returns callees of a function", async () => {
    const opts = await setup();
    const defs = await queryDefs("main", opts);
    expect(defs.symbols.length).toBeGreaterThan(0);
    const symId = defs.symbols[0]!.id;

    const result = await queryCallees(symId, opts);
    // main calls NewService and Hello
    expect(result.callees.length).toBeGreaterThan(0);
    const calleeIds = result.callees.map((c) => c.callee_id);
    expect(calleeIds.some((id) => id.includes("NewService"))).toBe(true);
  }, 30_000);

  test("queryDeadCode returns unreferenced exported symbols", async () => {
    const opts = await setup();
    const result = await queryDeadCode(opts);
    // All exported symbols that are unreferenced should appear
    // main and init are excluded by design
    expect(Array.isArray(result.deadSymbols)).toBe(true);
    // Verify none of the dead symbols are main/init
    for (const { symbol } of result.deadSymbols) {
      expect(symbol.name).not.toBe("main");
      expect(symbol.name).not.toBe("init");
    }
    // Verify dead symbols are exported
    for (const { symbol } of result.deadSymbols) {
      expect(symbol.exported).toBe(true);
    }
  }, 30_000);

  test("throws when no cached facts exist", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "query-test-"));
    cacheDir = join(tempDir, "cache");

    expect(
      queryDeps("unit:go:.", { repoRoot: TESTDATA, cacheDir }),
    ).rejects.toThrow("No cached facts found");
  });
});

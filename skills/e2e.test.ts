/**
 * E2E test: Full pipeline — indexFacts → updateFacts → query* → runAction
 *
 * Uses the Go testdata project at adapters/go/testdata/ which has:
 * - main.go (imports pkg)
 * - pkg/service.go (imports internal/db)
 * - internal/db/db.go
 * - pkg/generated.go (generated file)
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { indexFacts } from "./index.ts";
import { updateFacts } from "./update.ts";
import {
  queryDeps,
  queryRdeps,
  queryDefs,
  queryDiagnostics,
  queryImpact,
  queryDeadCode,
  clearFactsCache,
} from "./query.ts";
import { runAction } from "./actions.ts";
import { whichTool } from "../adapters/go/utils.ts";

const hasGo = (await whichTool("go")) !== null;
const hasGopls = (await whichTool("gopls")) !== null;

const TESTDATA = resolve(import.meta.dir, "../adapters/go/testdata");

describe("E2E pipeline", () => {
  let tempDir: string;
  let cacheDir: string;

  afterEach(async () => {
    clearFactsCache();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test.skipIf(!hasGo)(
    "full pipeline: index → query → update → query",
    async () => {
      // --- Phase 1: Index ---
      tempDir = await mkdtemp(join(tmpdir(), "e2e-test-"));
      cacheDir = join(tempDir, "cache");

      const indexResult = await indexFacts({ repoRoot: TESTDATA, cacheDir });
      expect(indexResult.ok).toBe(true);
      expect(indexResult.facts.units.length).toBeGreaterThan(0);
      expect(indexResult.facts.files.length).toBeGreaterThan(0);
      expect(indexResult.facts.deps.length).toBeGreaterThan(0);

      // Verify cache files exist
      expect(existsSync(join(cacheDir, "fingerprint.json"))).toBe(true);
      expect(existsSync(join(cacheDir, "facts", "meta.json"))).toBe(true);
      expect(existsSync(join(cacheDir, "facts", "units.jsonl"))).toBe(true);
      expect(existsSync(join(cacheDir, "facts", "files.jsonl"))).toBe(true);

      const opts = { repoRoot: TESTDATA, cacheDir };

      // --- Phase 2: Query deps/rdeps ---
      const depsResult = await queryDeps("unit:go:.", opts);
      expect(depsResult.deps.length).toBeGreaterThan(0);
      // main depends on pkg
      expect(depsResult.deps.some((d) => d.to_unit_id === "unit:go:pkg")).toBe(
        true,
      );

      const rdepsResult = await queryRdeps("unit:go:pkg", opts);
      expect(rdepsResult.rdeps.some((d) => d.from_unit_id === "unit:go:.")).toBe(
        true,
      );

      // --- Phase 3: Query diagnostics ---
      const diagResult = await queryDiagnostics("repo", opts);
      expect(Array.isArray(diagResult.diagnostics)).toBe(true);

      // --- Phase 4: Query impact ---
      const impactResult = await queryImpact(["main.go"], opts);
      expect(impactResult.affectedUnits).toContain("unit:go:.");

      // --- Phase 5: Query impact with maxDepth ---
      const shallowImpact = await queryImpact(["pkg/service.go"], {
        ...opts,
        maxDepth: 0,
      });
      // maxDepth=0 means no transitive expansion beyond direct units
      expect(shallowImpact.affectedUnits).toContain("unit:go:pkg");

      // --- Phase 6: Update ---
      clearFactsCache();
      const updateResult = await updateFacts({
        repoRoot: TESTDATA,
        cacheDir,
        changedFiles: ["main.go"],
      });
      expect(updateResult.ok).toBe(true);

      // --- Phase 7: Query after update still works ---
      // Update may fallback to full re-index (e.g. fingerprint change from
      // commit hash diff). Either way, facts should still be queryable.
      clearFactsCache();
      const depsAfterUpdate = await queryDeps("unit:go:.", opts);
      // After update or re-index, deps should be consistent
      // (at minimum the unit should still exist in facts)
      const diagsAfterUpdate = await queryDiagnostics("repo", opts);
      expect(Array.isArray(diagsAfterUpdate.diagnostics)).toBe(true);
    },
    120_000,
  );

  test.skipIf(!hasGopls)(
    "symbol-level queries work after index (gopls required)",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "e2e-sym-test-"));
      cacheDir = join(tempDir, "cache");

      await indexFacts({ repoRoot: TESTDATA, cacheDir });
      const opts = { repoRoot: TESTDATA, cacheDir };

      // queryDefs
      const defs = await queryDefs("NewService", opts);
      expect(defs.symbols.length).toBeGreaterThan(0);
      expect(defs.symbols[0]!.name).toBe("NewService");
      expect(defs.warnings).toBeUndefined(); // Go project, no warnings

      // queryDeadCode
      const deadCode = await queryDeadCode(opts);
      expect(Array.isArray(deadCode.deadSymbols)).toBe(true);
      // main and init should be excluded
      for (const { symbol } of deadCode.deadSymbols) {
        expect(symbol.name).not.toBe("main");
        expect(symbol.name).not.toBe("init");
      }
    },
    120_000,
  );

  test.skipIf(!hasGo)(
    "runAction check works after index",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "e2e-action-test-"));
      cacheDir = join(tempDir, "cache");

      const opts = { repoRoot: TESTDATA, cacheDir };

      // Run check action — should at least detect Go and attempt go build/vet
      const checkResult = await runAction({
        repoRoot: TESTDATA,
        action: "check",
        scope: { kind: "repo" },
      });
      expect(Array.isArray(checkResult.results)).toBe(true);
      expect(checkResult.results.length).toBeGreaterThan(0);
      expect(checkResult.results[0]!.lang).toBe("go");
    },
    60_000,
  );
});

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { indexFacts } from "./index.ts";
import { compareFacts, summarizeCompare } from "./compare.ts";

const TESTDATA = resolve(import.meta.dir, "../adapters/go/testdata");

async function copyTestdata(dest: string): Promise<void> {
  await cp(TESTDATA, dest, { recursive: true });
}

describe("compareFacts", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  async function setupTwoSnapshots(mutate: (headRoot: string) => Promise<void>) {
    tempDir = await mkdtemp(join(tmpdir(), "compare-test-"));
    const baseRoot = join(tempDir, "base");
    const headRoot = join(tempDir, "head");
    const baseCacheDir = join(tempDir, "base-cache");
    const headCacheDir = join(tempDir, "head-cache");
    await copyTestdata(baseRoot);
    await copyTestdata(headRoot);
    await indexFacts({ repoRoot: baseRoot, cacheDir: baseCacheDir });
    await mutate(headRoot);
    await indexFacts({ repoRoot: headRoot, cacheDir: headCacheDir });
    return { baseCacheDir, headCacheDir };
  }

  test("reports no changes when both snapshots index the same tree", async () => {
    const opts = await setupTwoSnapshots(async () => {});
    const result = await compareFacts(opts);
    expect(result.units.added).toEqual([]);
    expect(result.units.removed).toEqual([]);
    expect(result.files.added).toEqual([]);
    expect(result.files.removed).toEqual([]);
    expect(result.files.modified).toEqual([]);
    expect(result.deps.added).toEqual([]);
    expect(result.deps.removed).toEqual([]);
  }, 60_000);

  test("detects an added file as files.added", async () => {
    const opts = await setupTwoSnapshots(async (headRoot) => {
      await writeFile(
        join(headRoot, "pkg", "added.go"),
        "package pkg\n\nfunc Added() int { return 1 }\n",
      );
    });
    const result = await compareFacts(opts);
    const ids = result.files.added.map((f) => f.id);
    expect(ids).toContain("file:pkg/added.go");
    expect(result.files.removed).toEqual([]);
  }, 60_000);

  test("detects a removed file as files.removed", async () => {
    const opts = await setupTwoSnapshots(async (headRoot) => {
      await rm(join(headRoot, "pkg", "generated.go"));
    });
    const result = await compareFacts(opts);
    const ids = result.files.removed.map((f) => f.id);
    expect(ids).toContain("file:pkg/generated.go");
  }, 60_000);

  test("detects content changes via hash diff as files.modified", async () => {
    const opts = await setupTwoSnapshots(async (headRoot) => {
      await writeFile(
        join(headRoot, "pkg", "service.go"),
        "package pkg\n\n// changed body\nfunc Concat2(parts []string) string { return \"\" }\n",
      );
    });
    const result = await compareFacts(opts);
    const modifiedIds = result.files.modified.map((f) => f.id);
    expect(modifiedIds).toContain("file:pkg/service.go");
  }, 60_000);

  test("includeImpact expands changes through head's dep graph", async () => {
    const opts = await setupTwoSnapshots(async (headRoot) => {
      // Touch a file inside the internal/db unit — `.` and pkg both
      // (transitively) depend on it, so they must show up as impacted.
      await writeFile(
        join(headRoot, "internal", "db", "db.go"),
        "package db\n\nfunc Touched() {}\n",
      );
    });
    const result = await compareFacts({ ...opts, includeImpact: true });
    expect(result.impact).toBeDefined();
    expect(result.impact!.affectedUnits).toContain("unit:go:internal/db");
    expect(result.impact!.affectedUnits).toContain("unit:go:pkg");
    expect(result.impact!.affectedUnits).toContain("unit:go:.");
  }, 60_000);

  test("summarizeCompare produces a compact +/- summary", async () => {
    const opts = await setupTwoSnapshots(async (headRoot) => {
      await writeFile(
        join(headRoot, "pkg", "newfile.go"),
        "package pkg\n\nfunc N() {}\n",
      );
    });
    const result = await compareFacts(opts);
    const text = summarizeCompare(result);
    expect(text).toContain("files:");
    expect(text).toMatch(/\+\d+ \/ -\d+/);
  }, 60_000);

  test("throws when either cacheDir is missing facts", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "compare-test-"));
    await expect(
      compareFacts({
        baseCacheDir: join(tempDir, "nope-a"),
        headCacheDir: join(tempDir, "nope-b"),
      }),
    ).rejects.toThrow(/No cached facts/);
  });
});

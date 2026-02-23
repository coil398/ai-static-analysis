import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { indexFacts } from "./index.ts";
import { updateFacts } from "./update.ts";

const TESTDATA = resolve(
  import.meta.dir,
  "../adapters/go/testdata",
);

describe("updateFacts", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test("falls back to full index when no cache exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "update-test-"));
    const cacheDir = join(tempDir, "cache");

    const result = await updateFacts({
      repoRoot: TESTDATA,
      changedFiles: ["main.go"],
      cacheDir,
    });

    expect(result.ok).toBe(true);
    expect(result.fallbackToIndex).toBe(true);
    expect(result.facts.units.length).toBeGreaterThan(0);
  });

  test("incrementally updates affected units", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "update-test-"));
    const cacheDir = join(tempDir, "cache");

    // First: full index
    await indexFacts({ repoRoot: TESTDATA, cacheDir });

    // Update with a changed file
    const result = await updateFacts({
      repoRoot: TESTDATA,
      changedFiles: ["main.go"],
      cacheDir,
    });

    expect(result.ok).toBe(true);
    expect(result.fallbackToIndex).toBe(false);
    expect(result.affectedUnits).toContain("unit:go:.");
    expect(result.facts.units.length).toBeGreaterThan(0);
  });

  test("returns no changes for unknown files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "update-test-"));
    const cacheDir = join(tempDir, "cache");

    await indexFacts({ repoRoot: TESTDATA, cacheDir });

    const result = await updateFacts({
      repoRoot: TESTDATA,
      changedFiles: ["nonexistent.go"],
      cacheDir,
    });

    expect(result.ok).toBe(true);
    expect(result.fallbackToIndex).toBe(false);
    expect(result.affectedUnits).toHaveLength(0);
  });
});

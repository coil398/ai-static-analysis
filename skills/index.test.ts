import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { indexFacts } from "./index.ts";

const TESTDATA = resolve(
  import.meta.dir,
  "../adapters/go/testdata",
);

describe("indexFacts", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test("indexes Go testdata project", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");

    const result = await indexFacts({
      repoRoot: TESTDATA,
      cacheDir,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.facts.units.length).toBeGreaterThan(0);
    expect(result.facts.files.length).toBeGreaterThan(0);

    // Verify units contain expected packages
    const unitIds = result.facts.units.map((u) => u.id);
    expect(unitIds).toContain("unit:go:.");
    expect(unitIds).toContain("unit:go:pkg");

    // Verify files are indexed
    const filePaths = result.facts.files.map((f) => f.path);
    expect(filePaths).toContain("main.go");

    // Verify deps exist (main imports pkg)
    expect(result.facts.deps.length).toBeGreaterThan(0);
  });

  test("persists facts and fingerprint to cache", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");

    await indexFacts({ repoRoot: TESTDATA, cacheDir });

    const factsFile = Bun.file(join(cacheDir, "facts.json"));
    const fpFile = Bun.file(join(cacheDir, "fingerprint.json"));
    expect(await factsFile.exists()).toBe(true);
    expect(await fpFile.exists()).toBe(true);
  });

  test("second index reuses fingerprint check", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");

    // First index
    await indexFacts({ repoRoot: TESTDATA, cacheDir });
    // Second index — fingerprint matches, should still succeed
    const result = await indexFacts({ repoRoot: TESTDATA, cacheDir });

    expect(result.ok).toBe(true);
    expect(result.facts.units.length).toBeGreaterThan(0);
  });
});

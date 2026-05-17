import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { indexFacts } from "./index.ts";
import { whichTool } from "../adapters/go/utils.ts";

const hasGopls = await whichTool("gopls") !== null;

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

    // Verify symbols are populated via gopls (when available)
    if (hasGopls) {
      expect(result.facts.symbols.length).toBeGreaterThan(0);
    }
  }, 30_000);

  test("persists facts and fingerprint to cache", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");

    await indexFacts({ repoRoot: TESTDATA, cacheDir });

    // JSONL format: facts are written to cache/facts/ directory
    const metaFile = Bun.file(join(cacheDir, "facts", "meta.json"));
    const fpFile = Bun.file(join(cacheDir, "fingerprint.json"));
    expect(await metaFile.exists()).toBe(true);
    expect(await fpFile.exists()).toBe(true);
  }, 30_000);

  test("second index reuses fingerprint check", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");

    // First index
    await indexFacts({ repoRoot: TESTDATA, cacheDir });
    // Second index — fingerprint matches, should still succeed
    const result = await indexFacts({ repoRoot: TESTDATA, cacheDir });

    expect(result.ok).toBe(true);
    expect(result.facts.units.length).toBeGreaterThan(0);
  }, 60_000);

  test("onProgress callback is called for each phase", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");

    const messages: string[] = [];
    const result = await indexFacts({
      repoRoot: TESTDATA,
      cacheDir,
      onProgress: (msg) => messages.push(msg),
    });

    expect(result.ok).toBe(true);
    // 7フェーズ分のメッセージが出力されること
    expect(messages.some((m) => m.includes("[1/7]"))).toBe(true);
    expect(messages.some((m) => m.includes("[2/7]"))).toBe(true);
    expect(messages.some((m) => m.includes("[3/7]"))).toBe(true);
    expect(messages.some((m) => m.includes("[4/7]"))).toBe(true);
    expect(messages.some((m) => m.includes("[5/7]"))).toBe(true);
    expect(messages.some((m) => m.includes("[6/7]"))).toBe(true);
    expect(messages.some((m) => m.includes("[7/7]"))).toBe(true);
  }, 30_000);
});

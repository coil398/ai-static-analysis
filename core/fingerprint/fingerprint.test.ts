import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Fingerprint } from "../schema/index.ts";
import {
  compareFingerprint,
  generateFingerprint,
  wipeCache,
} from "./fingerprint.ts";

describe("compareFingerprint", () => {
  const base: Fingerprint = {
    schema_version: 1,
    tools: { bun: "1.0.0", go: "go1.22" },
    build_profile: { os: "linux", arch: "x64" },
    repo_state: { commit: "abc123" },
    created_at: "2026-02-15T00:00:00Z",
  };

  test("identical fingerprints match", () => {
    const result = compareFingerprint(base, { ...base });
    expect(result.match).toBe(true);
    expect(result.diffs).toHaveLength(0);
  });

  test("detects schema_version change", () => {
    const modified = { ...base, schema_version: 2 };
    const result = compareFingerprint(modified, base);
    expect(result.match).toBe(false);
    expect(result.diffs).toContainEqual(
      expect.stringContaining("schema_version"),
    );
  });

  test("detects tool version change", () => {
    const modified = { ...base, tools: { ...base.tools, bun: "2.0.0" } };
    const result = compareFingerprint(modified, base);
    expect(result.match).toBe(false);
    expect(result.diffs).toContainEqual(expect.stringContaining("tools.bun"));
  });

  test("detects added tool", () => {
    const modified = {
      ...base,
      tools: { ...base.tools, node: "v22.0.0" },
    };
    const result = compareFingerprint(modified, base);
    expect(result.match).toBe(false);
    expect(result.diffs).toContainEqual(expect.stringContaining("tools.node"));
  });

  test("detects removed tool", () => {
    const modified = { ...base, tools: { bun: "1.0.0" } };
    const result = compareFingerprint(modified, base);
    expect(result.match).toBe(false);
    expect(result.diffs).toContainEqual(expect.stringContaining("tools.go"));
  });

  test("detects build_profile change", () => {
    const modified = {
      ...base,
      build_profile: { ...base.build_profile, os: "darwin" },
    };
    const result = compareFingerprint(modified, base);
    expect(result.match).toBe(false);
    expect(result.diffs).toContainEqual(
      expect.stringContaining("build_profile.os"),
    );
  });
});

describe("generateFingerprint", () => {
  test("generates a valid fingerprint", async () => {
    const fp = await generateFingerprint(process.cwd());
    expect(fp.schema_version).toBe(1);
    expect(fp.created_at).toBeTruthy();
    expect(fp.repo_state.commit).toBeTruthy();
    expect(fp.build_profile.os).toBe(process.platform);
    expect(fp.build_profile.arch).toBe(process.arch);
    // bun should be detected since we're running in bun
    expect(fp.tools.bun).toBeTruthy();
  });
});

describe("wipeCache", () => {
  let tempDir: string;

  afterEach(async () => {
    // cleanup if needed (wipe may have already removed it)
  });

  test("removes cache directory", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "wipe-test-"));
    const cacheDir = join(tempDir, "cache");
    await mkdir(cacheDir, { recursive: true });
    await Bun.write(join(cacheDir, "test.json"), "{}");

    await wipeCache(cacheDir);

    const exists = await stat(cacheDir).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(false);
  });

  test("does not throw on missing directory", async () => {
    const nonExistent = join(tmpdir(), "nonexistent-cache-dir-" + Date.now());
    // Should not throw
    await wipeCache(nonExistent);
  });
});

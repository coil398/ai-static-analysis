import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Facts, Fingerprint } from "../schema/index.ts";
import {
  readFacts,
  writeFacts,
  readFingerprint,
  writeFingerprint,
} from "./storage.ts";

describe("storage", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  const sampleFacts: Facts = {
    schema_version: 1,
    snapshot: { commit: "abc123", created_at: "2026-02-15T00:00:00Z" },
    units: [],
    files: [],
    deps: [],
    symbols: [],
    refs: [],
    diagnostics: [],
  };

  const sampleFingerprint: Fingerprint = {
    schema_version: 1,
    tools: { bun: "1.0.0" },
    build_profile: { os: "linux" },
    repo_state: { commit: "abc123" },
    created_at: "2026-02-15T00:00:00Z",
  };

  test("readFacts returns null for missing file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "storage-test-"));
    const result = await readFacts(tempDir);
    expect(result).toBeNull();
  });

  test("writeFacts + readFacts round-trip", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "storage-test-"));
    const cacheDir = join(tempDir, "cache");

    await writeFacts(cacheDir, sampleFacts);
    const result = await readFacts(cacheDir);

    expect(result).toEqual(sampleFacts);
  });

  test("readFingerprint returns null for missing file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "storage-test-"));
    const result = await readFingerprint(tempDir);
    expect(result).toBeNull();
  });

  test("writeFingerprint + readFingerprint round-trip", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "storage-test-"));
    const cacheDir = join(tempDir, "cache");

    await writeFingerprint(cacheDir, sampleFingerprint);
    const result = await readFingerprint(cacheDir);

    expect(result).toEqual(sampleFingerprint);
  });
});

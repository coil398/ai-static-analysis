import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Facts } from "../schema/index.ts";
import { buildIndexes, loadUnitByFile, loadSymbolByName, loadRefsBySymbol } from "./index.ts";
import { readFacts, writeFacts, writeFactsJsonl } from "../storage/storage.ts";

const sampleFacts: Facts = {
  schema_version: 1,
  snapshot: { commit: "abc123", created_at: "2026-02-24T00:00:00Z" },
  units: [
    { id: "unit:go:.", kind: "go_module", name: "main", path: "." },
    { id: "unit:go:pkg", kind: "go_module", name: "pkg", path: "pkg" },
  ],
  files: [
    { id: "file:main.go", path: "main.go", unit_id: "unit:go:.", hash: "h1", generated: false },
    { id: "file:pkg/lib.go", path: "pkg/lib.go", unit_id: "unit:go:pkg", hash: "h2", generated: false },
  ],
  deps: [
    { from_unit_id: "unit:go:.", to_unit_id: "unit:go:pkg", kind: "import" },
  ],
  symbols: [
    {
      id: "sym:go:main#main#func()",
      unit_id: "unit:go:.",
      name: "main",
      kind: "func",
      exported: false,
      decl: { file_id: "file:main.go", position: { line: 1, column: 1 } },
    },
    {
      id: "sym:go:pkg#Lib#func()",
      unit_id: "unit:go:pkg",
      name: "Lib",
      kind: "func",
      exported: true,
      decl: { file_id: "file:pkg/lib.go", position: { line: 1, column: 1 } },
    },
    {
      id: "sym:go:pkg#Lib2#func()",
      unit_id: "unit:go:pkg",
      name: "Lib",  // intentionally same name as above to test multi-entry
      kind: "func",
      exported: true,
      decl: { file_id: "file:pkg/lib.go", position: { line: 5, column: 1 } },
    },
  ],
  refs: [
    {
      from_symbol_id: "sym:go:main#main#func()",
      to_symbol_id: "sym:go:pkg#Lib#func()",
      site: { file_id: "file:main.go", position: { line: 3, column: 2 } },
      kind: "call",
      confidence: "certain",
    },
    {
      from_symbol_id: "sym:go:main#main#func()",
      to_symbol_id: "sym:go:pkg#Lib#func()",
      site: { file_id: "file:main.go", position: { line: 4, column: 2 } },
      kind: "call",
      confidence: "certain",
    },
  ],
  type_relations: [],
  call_edges: [],
  diagnostics: [],
};

describe("buildIndexes + loadXxx", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test("buildIndexes writes unit_by_file index", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");
    await buildIndexes(cacheDir, sampleFacts);

    const index = await loadUnitByFile(cacheDir);
    expect(index).not.toBeNull();
    expect(index!["file:main.go"]).toBe("unit:go:.");
    expect(index!["file:pkg/lib.go"]).toBe("unit:go:pkg");
  });

  test("buildIndexes writes symbol_by_name index (multi-value)", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");
    await buildIndexes(cacheDir, sampleFacts);

    const index = await loadSymbolByName(cacheDir);
    expect(index).not.toBeNull();
    // "main" has one symbol
    expect(index!["main"]).toEqual(["sym:go:main#main#func()"]);
    // "Lib" has two symbols (same name, different id)
    expect(index!["Lib"]).toHaveLength(2);
    expect(index!["Lib"]).toContain("sym:go:pkg#Lib#func()");
    expect(index!["Lib"]).toContain("sym:go:pkg#Lib2#func()");
  });

  test("buildIndexes writes refs_by_symbol index", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");
    await buildIndexes(cacheDir, sampleFacts);

    const index = await loadRefsBySymbol(cacheDir);
    expect(index).not.toBeNull();
    const refs = index!["sym:go:pkg#Lib#func()"];
    expect(refs).toHaveLength(2);
    expect(refs[0].from_symbol_id).toBe("sym:go:main#main#func()");
  });

  test("loadUnitByFile returns null when index missing", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");
    const result = await loadUnitByFile(cacheDir);
    expect(result).toBeNull();
  });

  test("loadSymbolByName returns null when index missing", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");
    const result = await loadSymbolByName(cacheDir);
    expect(result).toBeNull();
  });

  test("loadRefsBySymbol returns null when index missing", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");
    const result = await loadRefsBySymbol(cacheDir);
    expect(result).toBeNull();
  });
});

describe("readFacts JSONL auto-detection", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test("readFacts falls back to JSON when no JSONL dir", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");
    await writeFacts(cacheDir, sampleFacts);
    const result = await readFacts(cacheDir);
    expect(result).not.toBeNull();
    expect(result!.units).toHaveLength(2);
    expect(result!.schema_version).toBe(1);
  });

  test("readFacts uses JSONL when cache/facts/ dir exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");
    await writeFactsJsonl(cacheDir, sampleFacts);
    const result = await readFacts(cacheDir);
    expect(result).not.toBeNull();
    expect(result!.units).toHaveLength(2);
    expect(result!.files).toHaveLength(2);
    expect(result!.symbols).toHaveLength(3);
    expect(result!.refs).toHaveLength(2);
    expect(result!.deps).toHaveLength(1);
    expect(result!.schema_version).toBe(1);
    expect(result!.snapshot.commit).toBe("abc123");
  });

  test("JSONL round-trip preserves all fields", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");
    await writeFactsJsonl(cacheDir, sampleFacts);
    const result = await readFacts(cacheDir);
    expect(result!.units[0]).toEqual(sampleFacts.units[0]);
    expect(result!.refs[0]).toEqual(sampleFacts.refs[0]);
    expect(result!.diagnostics).toEqual([]);
    expect(result!.type_relations).toEqual([]);
    expect(result!.call_edges).toEqual([]);
  });

  test("readFacts returns null when neither format exists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "index-test-"));
    const cacheDir = join(tempDir, "cache");
    const result = await readFacts(cacheDir);
    expect(result).toBeNull();
  });
});

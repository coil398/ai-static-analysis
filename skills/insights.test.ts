import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Facts, Insights } from "../core/schema/types.ts";
import { writeFacts, writeInsights } from "../core/storage/index.ts";
import {
  loadInsightContext,
  queryIntents,
  querySummaries,
  querySmells,
  queryPatterns,
  queryNaming,
} from "./insights.ts";

// --- Fixtures ---

const sampleFacts: Facts = {
  schema_version: 1,
  snapshot: { commit: "abc123", created_at: "2026-02-24T00:00:00Z" },
  units: [
    { id: "unit:go:.", kind: "go_module", name: "main", path: "." },
  ],
  files: [
    { id: "file:main.go", path: "main.go", unit_id: "unit:go:.", hash: "h1", generated: false },
  ],
  deps: [],
  symbols: [
    {
      id: "sym:go:main#Foo#func()",
      unit_id: "unit:go:.",
      name: "Foo",
      kind: "func",
      exported: true,
      decl: { file_id: "file:main.go", position: { line: 1, column: 1 } },
    },
  ],
  refs: [],
  type_relations: [],
  call_edges: [],
  diagnostics: [],
};

const now = "2026-02-24T00:00:00Z";
const sampleInsights: Insights = {
  schema_version: 1,
  snapshot: { commit: "abc123", created_at: now },
  intent_tags: [
    {
      target_id: "unit:go:.",
      target_kind: "unit",
      intent: "entry-point",
      reasoning: "contains main function",
      meta: { model: "claude-sonnet-4-6", confidence: 0.9, generated_at: now },
    },
    {
      target_id: "sym:go:main#Foo#func()",
      target_kind: "symbol",
      intent: "helper",
      reasoning: "utility function",
      meta: { model: "claude-sonnet-4-6", confidence: 0.5, generated_at: now },
    },
  ],
  summaries: [
    {
      target_id: "unit:go:.",
      target_kind: "unit",
      text: "Main package with entry point.",
      meta: { model: "claude-sonnet-4-6", confidence: 0.95, generated_at: now },
    },
  ],
  bug_smells: [
    {
      file_id: "file:main.go",
      position: { line: 5, column: 3 },
      smell: "swallowed_error",
      message: "error return value ignored",
      severity: "high",
      meta: { model: "claude-sonnet-4-6", confidence: 0.8, generated_at: now },
    },
    {
      file_id: "file:main.go",
      position: { line: 10, column: 1 },
      smell: "nil_check_missing",
      message: "pointer dereference without nil check",
      severity: "medium",
      meta: { model: "claude-sonnet-4-6", confidence: 0.4, generated_at: now },
    },
  ],
  pattern_tags: [
    {
      target_id: "unit:go:.",
      target_kind: "unit",
      pattern: "factory",
      participants: ["sym:go:main#Foo#func()"],
      meta: { model: "claude-sonnet-4-6", confidence: 0.7, generated_at: now },
    },
  ],
  naming_issues: [
    {
      symbol_id: "sym:go:main#Foo#func()",
      issue: "too_generic",
      current_name: "Foo",
      suggestion: "CreateWidget",
      message: "Name 'Foo' is too generic",
      meta: { model: "claude-sonnet-4-6", confidence: 0.85, generated_at: now },
    },
  ],
};

// --- Tests ---

describe("loadInsightContext", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test("loads facts and source files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "insights-test-"));
    const repoRoot = join(tempDir, "repo");
    const cacheDir = join(tempDir, "cache");
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, "main.go"), "package main\n");
    await writeFacts(cacheDir, sampleFacts);

    const ctx = await loadInsightContext({ repoRoot, cacheDir });
    expect(ctx.facts.units).toHaveLength(1);
    expect(ctx.sources["file:main.go"]).toBe("package main\n");
  });

  test("scopes to unit_ids", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "insights-test-"));
    const repoRoot = join(tempDir, "repo");
    const cacheDir = join(tempDir, "cache");
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, "main.go"), "package main\n");

    const factsWithExtra: Facts = {
      ...sampleFacts,
      units: [
        ...sampleFacts.units,
        { id: "unit:go:pkg", kind: "go_module", name: "pkg", path: "pkg" },
      ],
      files: [
        ...sampleFacts.files,
        { id: "file:pkg/lib.go", path: "pkg/lib.go", unit_id: "unit:go:pkg", hash: "h2", generated: false },
      ],
    };
    await writeFacts(cacheDir, factsWithExtra);

    const ctx = await loadInsightContext({
      repoRoot,
      cacheDir,
      scope: { unit_ids: ["unit:go:."] },
    });
    expect(Object.keys(ctx.sources)).toContain("file:main.go");
    expect(Object.keys(ctx.sources)).not.toContain("file:pkg/lib.go");
  });

  test("throws when no facts cached", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "insights-test-"));
    const repoRoot = join(tempDir, "repo");
    const cacheDir = join(tempDir, "cache");
    await mkdir(repoRoot, { recursive: true });

    expect(
      loadInsightContext({ repoRoot, cacheDir }),
    ).rejects.toThrow("No cached facts found");
  });
});

describe("queryIntents", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  async function setup() {
    tempDir = await mkdtemp(join(tmpdir(), "insights-test-"));
    const cacheDir = join(tempDir, "cache");
    await writeInsights(cacheDir, sampleInsights);
    return { repoRoot: tempDir, cacheDir };
  }

  test("returns all intent tags when no targetId", async () => {
    const opts = await setup();
    const result = await queryIntents(undefined, opts);
    expect(result).toHaveLength(2);
  });

  test("filters by targetId", async () => {
    const opts = await setup();
    const result = await queryIntents("unit:go:.", opts);
    expect(result).toHaveLength(1);
    expect(result[0].intent).toBe("entry-point");
  });

  test("filters by minConfidence", async () => {
    const opts = await setup();
    const result = await queryIntents(undefined, { ...opts, minConfidence: 0.8 });
    expect(result).toHaveLength(1);
    expect(result[0].meta.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("throws when no insights cached", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "insights-test-"));
    const cacheDir = join(tempDir, "cache");
    expect(
      queryIntents(undefined, { repoRoot: tempDir, cacheDir }),
    ).rejects.toThrow("No cached insights found");
  });
});

describe("querySummaries", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test("returns matching summaries", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "insights-test-"));
    const cacheDir = join(tempDir, "cache");
    await writeInsights(cacheDir, sampleInsights);

    const result = await querySummaries("unit:go:.", { repoRoot: tempDir, cacheDir });
    expect(result).toHaveLength(1);
    expect(result[0].text).toContain("Main package");
  });
});

describe("querySmells", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  async function setup() {
    tempDir = await mkdtemp(join(tmpdir(), "insights-test-"));
    const cacheDir = join(tempDir, "cache");
    await writeInsights(cacheDir, sampleInsights);
    return { repoRoot: tempDir, cacheDir };
  }

  test("returns all smells when no filter", async () => {
    const opts = await setup();
    const result = await querySmells(undefined, opts);
    expect(result).toHaveLength(2);
  });

  test("filters by severity", async () => {
    const opts = await setup();
    const result = await querySmells({ severity: "high" }, opts);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe("high");
  });

  test("filters by fileId", async () => {
    const opts = await setup();
    const result = await querySmells({ fileId: "file:main.go" }, opts);
    expect(result).toHaveLength(2);
  });

  test("filters by minConfidence", async () => {
    const opts = await setup();
    const result = await querySmells(undefined, { ...opts, minConfidence: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0].smell).toBe("swallowed_error");
  });
});

describe("queryPatterns", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test("filters by pattern name", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "insights-test-"));
    const cacheDir = join(tempDir, "cache");
    await writeInsights(cacheDir, sampleInsights);

    const result = await queryPatterns("factory", { repoRoot: tempDir, cacheDir });
    expect(result).toHaveLength(1);
    expect(result[0].pattern).toBe("factory");
  });

  test("returns empty for unknown pattern", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "insights-test-"));
    const cacheDir = join(tempDir, "cache");
    await writeInsights(cacheDir, sampleInsights);

    const result = await queryPatterns("singleton", { repoRoot: tempDir, cacheDir });
    expect(result).toHaveLength(0);
  });
});

describe("queryNaming", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test("returns all naming issues when no symbolId", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "insights-test-"));
    const cacheDir = join(tempDir, "cache");
    await writeInsights(cacheDir, sampleInsights);

    const result = await queryNaming(undefined, { repoRoot: tempDir, cacheDir });
    expect(result).toHaveLength(1);
    expect(result[0].current_name).toBe("Foo");
  });

  test("filters by symbolId", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "insights-test-"));
    const cacheDir = join(tempDir, "cache");
    await writeInsights(cacheDir, sampleInsights);

    const result = await queryNaming("sym:go:main#Foo#func()", { repoRoot: tempDir, cacheDir });
    expect(result).toHaveLength(1);
  });
});

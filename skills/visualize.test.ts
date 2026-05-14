import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { indexFacts } from "./index.ts";
import { visualizeGraph } from "./visualize.ts";
import { whichTool } from "../adapters/go/utils.ts";

const hasGopls = await whichTool("gopls") !== null;

const TESTDATA = resolve(import.meta.dir, "../adapters/go/testdata");

describe("visualizeGraph", () => {
  let tempDir: string;
  let cacheDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  async function setup() {
    tempDir = await mkdtemp(join(tmpdir(), "viz-test-"));
    cacheDir = join(tempDir, "cache");
    await indexFacts({ repoRoot: TESTDATA, cacheDir });
    return { repoRoot: TESTDATA, cacheDir };
  }

  test("renders a deps graph in Mermaid by default", async () => {
    const opts = await setup();
    const result = await visualizeGraph(opts);
    expect(result.format).toBe("mermaid");
    expect(result.kind).toBe("deps");
    expect(result.graph.startsWith("graph LR")).toBe(true);
    // testdata has three units with imports; expect at least one edge.
    expect(result.edgeCount).toBeGreaterThan(0);
    // Mermaid edges use "-->" syntax.
    expect(result.graph).toContain("-->");
  }, 30_000);

  test("renders a deps graph in DOT", async () => {
    const opts = await setup();
    const result = await visualizeGraph({ ...opts, format: "dot" });
    expect(result.format).toBe("dot");
    expect(result.graph.startsWith("digraph G")).toBe(true);
    expect(result.graph).toMatch(/->/);
    expect(result.graph.endsWith("}")).toBe(true);
  }, 30_000);

  test("only includes nodes that appear as edge endpoints", async () => {
    const opts = await setup();
    const result = await visualizeGraph(opts);
    const nodeIds = [...result.graph.matchAll(/^  (n\w+)\["/gm)].map((m) => m[1]!);
    const edgeLines = result.graph
      .split("\n")
      .filter((l) => l.includes("-->"));
    for (const id of nodeIds) {
      const used = edgeLines.some((l) => l.includes(id));
      expect(used).toBe(true);
    }
  }, 30_000);

  test("respects maxEdges and reports truncation", async () => {
    const opts = await setup();
    const result = await visualizeGraph({ ...opts, maxEdges: 1 });
    expect(result.edgeCount).toBeLessThanOrEqual(1);
    // With 1 edge cap we expect to drop at least one edge on the testdata fixture.
    expect(result.truncated).toBe(true);
  }, 30_000);

  test("match filter keeps only edges touching matching ids", async () => {
    const opts = await setup();
    const result = await visualizeGraph({ ...opts, match: ["internal/db"] });
    for (const line of result.graph.split("\n")) {
      const edgeMatch = /^  (n\w+) -->.* (n\w+)$/.exec(line);
      if (!edgeMatch) continue;
      // At least one endpoint of every kept edge must reference internal/db.
      expect(line).toContain("internal_db");
    }
  }, 30_000);

  test.skipIf(!hasGopls)(
    "callgraph kind renders edges from facts.call_edges",
    async () => {
      const opts = await setup();
      const result = await visualizeGraph({ ...opts, kind: "callgraph" });
      expect(result.kind).toBe("callgraph");
      // testdata main → NewService → CreateUser etc.; expect at least one edge.
      expect(result.edgeCount).toBeGreaterThan(0);
    },
    30_000,
  );

  test("throws when facts have not been indexed", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "viz-test-"));
    await expect(
      visualizeGraph({ repoRoot: TESTDATA, cacheDir: join(tempDir, "cache") }),
    ).rejects.toThrow(/No cached facts/);
  });
});

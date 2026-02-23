import { describe, expect, test } from "bun:test";
import { applyDelta, impactUnits } from "./diff.ts";
import type { Facts, FactsDelta } from "../schema/types.ts";

function makeFacts(overrides?: Partial<Facts>): Facts {
  return {
    schema_version: 1,
    snapshot: { commit: "abc123", created_at: "2026-01-01T00:00:00Z" },
    units: [],
    files: [],
    deps: [],
    symbols: [],
    refs: [],
    type_relations: [],
    call_edges: [],
    diagnostics: [],
    ...overrides,
  };
}

describe("applyDelta", () => {
  test("adds new units, files, deps", () => {
    const facts = makeFacts();
    const delta: FactsDelta = {
      added: {
        units: [{ id: "unit:go:pkg", kind: "go_package", name: "pkg", path: "pkg" }],
        files: [
          {
            id: "file:pkg/main.go",
            path: "pkg/main.go",
            unit_id: "unit:go:pkg",
            hash: "sha256:abc",
            generated: false,
          },
        ],
        deps: [
          { from_unit_id: "unit:go:pkg", to_unit_id: "unit:go:lib", kind: "import" },
        ],
      },
      removed: {},
    };

    const result = applyDelta(facts, delta);
    expect(result.units).toHaveLength(1);
    expect(result.files).toHaveLength(1);
    expect(result.deps).toHaveLength(1);
    expect(result.units[0]!.id).toBe("unit:go:pkg");
  });

  test("removes units by id", () => {
    const facts = makeFacts({
      units: [
        { id: "unit:go:a", kind: "go_package", name: "a", path: "a" },
        { id: "unit:go:b", kind: "go_package", name: "b", path: "b" },
      ],
    });
    const delta: FactsDelta = {
      added: {},
      removed: { units: ["unit:go:a"] },
    };

    const result = applyDelta(facts, delta);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]!.id).toBe("unit:go:b");
  });

  test("cascades unit removal to files, deps, symbols", () => {
    const facts = makeFacts({
      units: [{ id: "unit:go:a", kind: "go_package", name: "a", path: "a" }],
      files: [
        {
          id: "file:a/main.go",
          path: "a/main.go",
          unit_id: "unit:go:a",
          hash: "sha256:x",
          generated: false,
        },
      ],
      deps: [
        { from_unit_id: "unit:go:a", to_unit_id: "unit:go:b", kind: "import" },
      ],
      symbols: [
        {
          id: "sym:go:a#func#Foo#sig:0",
          unit_id: "unit:go:a",
          name: "Foo",
          kind: "func",
          exported: true,
          decl: { file_id: "file:a/main.go", position: { line: 1, column: 1 } },
        },
      ],
      diagnostics: [
        {
          file_id: "file:a/main.go",
          position: { line: 5, column: 1 },
          severity: "warning",
          message: "unused var",
          tool: "go_vet",
        },
      ],
    });

    const delta: FactsDelta = {
      added: {},
      removed: { units: ["unit:go:a"] },
    };

    const result = applyDelta(facts, delta);
    expect(result.units).toHaveLength(0);
    expect(result.files).toHaveLength(0);
    expect(result.deps).toHaveLength(0);
    expect(result.symbols).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
  });

  test("removes deps by composite key", () => {
    const facts = makeFacts({
      deps: [
        { from_unit_id: "unit:go:a", to_unit_id: "unit:go:b", kind: "import" },
        { from_unit_id: "unit:go:a", to_unit_id: "unit:go:c", kind: "import" },
      ],
    });
    const delta: FactsDelta = {
      added: {},
      removed: {
        deps: [{ from_unit_id: "unit:go:a", to_unit_id: "unit:go:b" }],
      },
    };

    const result = applyDelta(facts, delta);
    expect(result.deps).toHaveLength(1);
    expect(result.deps[0]!.to_unit_id).toBe("unit:go:c");
  });

  test("removes diagnostics by composite key", () => {
    const facts = makeFacts({
      files: [
        {
          id: "file:a.go",
          path: "a.go",
          unit_id: "unit:go:.",
          hash: "sha256:x",
          generated: false,
        },
      ],
      diagnostics: [
        {
          file_id: "file:a.go",
          position: { line: 5, column: 1 },
          severity: "warning",
          message: "unused var",
          tool: "go_vet",
        },
        {
          file_id: "file:a.go",
          position: { line: 10, column: 1 },
          severity: "warning",
          message: "other",
          tool: "go_vet",
        },
      ],
    });
    const delta: FactsDelta = {
      added: {},
      removed: {
        diagnostics: [
          { file_id: "file:a.go", position: { line: 5, column: 1 }, message: "unused var" },
        ],
      },
    };

    const result = applyDelta(facts, delta);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.message).toBe("other");
  });

  test("updates snapshot.created_at", () => {
    const facts = makeFacts();
    const before = facts.snapshot.created_at;
    const result = applyDelta(facts, { added: {}, removed: {} });
    expect(result.snapshot.created_at).not.toBe(before);
  });

  test("does not mutate original facts", () => {
    const facts = makeFacts({
      units: [{ id: "unit:go:a", kind: "go_package", name: "a", path: "a" }],
    });
    applyDelta(facts, { added: {}, removed: { units: ["unit:go:a"] } });
    expect(facts.units).toHaveLength(1);
  });
});

describe("impactUnits", () => {
  test("returns unit ids for changed files", () => {
    const facts = makeFacts({
      files: [
        {
          id: "file:pkg/a.go",
          path: "pkg/a.go",
          unit_id: "unit:go:pkg",
          hash: "sha256:x",
          generated: false,
        },
        {
          id: "file:lib/b.go",
          path: "lib/b.go",
          unit_id: "unit:go:lib",
          hash: "sha256:y",
          generated: false,
        },
        {
          id: "file:pkg/c.go",
          path: "pkg/c.go",
          unit_id: "unit:go:pkg",
          hash: "sha256:z",
          generated: false,
        },
      ],
    });

    const result = impactUnits(["pkg/a.go", "pkg/c.go"], facts);
    expect(result).toEqual(["unit:go:pkg"]);
  });

  test("handles file: prefixed paths", () => {
    const facts = makeFacts({
      files: [
        {
          id: "file:main.go",
          path: "main.go",
          unit_id: "unit:go:.",
          hash: "sha256:x",
          generated: false,
        },
      ],
    });

    const result = impactUnits(["file:main.go"], facts);
    expect(result).toEqual(["unit:go:."]);
  });

  test("returns empty for no matches", () => {
    const facts = makeFacts({
      files: [
        {
          id: "file:a.go",
          path: "a.go",
          unit_id: "unit:go:.",
          hash: "sha256:x",
          generated: false,
        },
      ],
    });

    const result = impactUnits(["nonexistent.go"], facts);
    expect(result).toEqual([]);
  });
});

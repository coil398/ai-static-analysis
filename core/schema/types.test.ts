import { describe, expect, test } from "bun:test";
import type { Facts, Fingerprint, FactsDelta } from "./index.ts";

describe("schema types", () => {
  test("Facts object conforms to the type structure", () => {
    const facts: Facts = {
      schema_version: 1,
      snapshot: {
        commit: "abc123",
        created_at: "2026-02-15T00:00:00Z",
      },
      units: [
        {
          id: "unit:go:pkg",
          kind: "go_package",
          name: "pkg",
          path: "pkg",
        },
      ],
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
        {
          from_unit_id: "unit:go:pkg",
          to_unit_id: "unit:go:lib",
          kind: "import",
        },
      ],
      symbols: [
        {
          id: "sym:go:pkg#func#Main#sig:0",
          unit_id: "unit:go:pkg",
          name: "Main",
          kind: "function",
          exported: true,
          decl: {
            file_id: "file:pkg/main.go",
            position: { line: 1, column: 1 },
          },
        },
      ],
      refs: [
        {
          from_symbol_id: "sym:go:pkg#func#Main#sig:0",
          to_symbol_id: "sym:go:lib#func#Helper#sig:0",
          site: {
            file_id: "file:pkg/main.go",
            position: { line: 5, column: 3 },
          },
          kind: "call",
          confidence: "certain",
        },
      ],
      diagnostics: [
        {
          file_id: "file:pkg/main.go",
          position: { line: 10, column: 1 },
          severity: "warning",
          message: "unused variable",
          tool: "gopls",
        },
      ],
    };

    expect(facts.schema_version).toBe(1);
    expect(facts.units).toHaveLength(1);
    expect(facts.files).toHaveLength(1);
    expect(facts.deps).toHaveLength(1);
    expect(facts.symbols).toHaveLength(1);
    expect(facts.refs).toHaveLength(1);
    expect(facts.diagnostics).toHaveLength(1);
  });

  test("Fingerprint object conforms to the type structure", () => {
    const fp: Fingerprint = {
      schema_version: 1,
      tools: { go: "go version go1.22.1" },
      build_profile: { GOOS: "linux", GOARCH: "amd64" },
      repo_state: { commit: "abc123" },
      created_at: "2026-02-15T00:00:00Z",
    };

    expect(fp.schema_version).toBe(1);
    expect(fp.tools.go).toContain("go");
    expect(fp.repo_state.commit).toBe("abc123");
  });

  test("FactsDelta supports added and removed", () => {
    const delta: FactsDelta = {
      added: {
        units: [
          { id: "unit:go:new", kind: "go_package", name: "new", path: "new" },
        ],
      },
      removed: {
        units: ["unit:go:old"],
      },
    };

    expect(delta.added.units).toHaveLength(1);
    expect(delta.removed.units).toHaveLength(1);
  });
});

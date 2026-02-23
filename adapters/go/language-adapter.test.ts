import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { GoLanguageAdapter, parseVetOutput } from "./language-adapter.ts";

const TESTDATA = resolve(import.meta.dir, "testdata");

describe("GoLanguageAdapter", () => {
  const adapter = new GoLanguageAdapter();

  test("detect returns supported for testdata", async () => {
    const result = await adapter.detect(TESTDATA);
    expect(result.supported).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  test("detect returns unsupported for non-go dir", async () => {
    const result = await adapter.detect("/tmp");
    expect(result.supported).toBe(false);
    expect(result.confidence).toBe(0);
  });

  test("doctor finds go tool", async () => {
    const result = await adapter.doctor();
    expect(result.ok).toBe(true);
    expect(result.missing_tools).not.toContain("go");
  });

  test("enumerateUnits returns packages", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    expect(units.length).toBeGreaterThanOrEqual(3); // main, pkg, internal/db

    const unitIds = units.map((u) => u.id);
    // The root package has path "." so id is "unit:go:."
    expect(unitIds).toContain("unit:go:.");
    expect(unitIds).toContain("unit:go:pkg");
    expect(unitIds).toContain("unit:go:internal/db");

    // Check unit structure
    const pkgUnit = units.find((u) => u.id === "unit:go:pkg");
    expect(pkgUnit).toBeDefined();
    expect(pkgUnit!.kind).toBe("go_package");
    expect(pkgUnit!.name).toBe("pkg");
    expect(pkgUnit!.metadata?.["import_path"]).toBe(
      "example.com/testproject/pkg",
    );
  });

  test("indexUnits produces files and deps", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    // Files should include go files from all packages
    const fileIds = delta.added.files?.map((f) => f.id) ?? [];
    expect(fileIds).toContain("file:main.go");
    expect(fileIds).toContain("file:pkg/service.go");
    expect(fileIds).toContain("file:pkg/generated.go");
    expect(fileIds).toContain("file:internal/db/db.go");

    // Check generated flag
    const genFile = delta.added.files?.find(
      (f) => f.id === "file:pkg/generated.go",
    );
    expect(genFile?.generated).toBe(true);

    const serviceFile = delta.added.files?.find(
      (f) => f.id === "file:pkg/service.go",
    );
    expect(serviceFile?.generated).toBe(false);

    // Check file hashes
    for (const f of delta.added.files ?? []) {
      expect(f.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }

    // Deps: main imports pkg, pkg imports internal/db
    const deps = delta.added.deps ?? [];
    expect(deps).toContainEqual({
      from_unit_id: "unit:go:.",
      to_unit_id: "unit:go:pkg",
      kind: "import",
    });
    expect(deps).toContainEqual({
      from_unit_id: "unit:go:pkg",
      to_unit_id: "unit:go:internal/db",
      kind: "import",
    });

    // MVP degrade: symbols, refs, type_relations, call_edges are empty
    expect(delta.added.symbols).toEqual([]);
    expect(delta.added.refs).toEqual([]);
    expect(delta.added.type_relations).toEqual([]);
    expect(delta.added.call_edges).toEqual([]);
  });

  test("diagnose runs go vet without errors on clean code", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const diags = await adapter.diagnose(units, {});
    // testdata is clean code, should have no diagnostics
    expect(diags).toEqual([]);
  });
});

describe("parseVetOutput", () => {
  test("parses standard go vet output", () => {
    const stderr = `# example.com/app
internal/handler/user.go:42:12: printf: fmt.Sprintf format %d arg count mismatch
internal/handler/user.go:50: unreachable code
`;
    const diags = parseVetOutput(stderr, "/repo");
    expect(diags).toHaveLength(2);
    expect(diags[0]).toEqual({
      file_id: "file:internal/handler/user.go",
      position: { line: 42, column: 12 },
      severity: "warning",
      message: "printf: fmt.Sprintf format %d arg count mismatch",
      tool: "go_vet",
    });
    expect(diags[1]).toEqual({
      file_id: "file:internal/handler/user.go",
      position: { line: 50, column: 1 },
      severity: "warning",
      message: "unreachable code",
      tool: "go_vet",
    });
  });

  test("returns empty for clean output", () => {
    expect(parseVetOutput("", "/repo")).toEqual([]);
  });
});

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
    expect(units.length).toBeGreaterThanOrEqual(3);

    const unitIds = units.map((u) => u.id);
    expect(unitIds).toContain("unit:go:.");
    expect(unitIds).toContain("unit:go:pkg");
    expect(unitIds).toContain("unit:go:internal/db");

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

    // Files
    const fileIds = delta.added.files?.map((f) => f.id) ?? [];
    expect(fileIds).toContain("file:main.go");
    expect(fileIds).toContain("file:pkg/service.go");
    expect(fileIds).toContain("file:pkg/generated.go");
    expect(fileIds).toContain("file:internal/db/db.go");

    // Generated flag
    const genFile = delta.added.files?.find(
      (f) => f.id === "file:pkg/generated.go",
    );
    expect(genFile?.generated).toBe(true);

    const serviceFile = delta.added.files?.find(
      (f) => f.id === "file:pkg/service.go",
    );
    expect(serviceFile?.generated).toBe(false);

    // File hashes
    for (const f of delta.added.files ?? []) {
      expect(f.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }

    // Deps
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
  }, 30_000);

  test("indexUnits produces symbols via gopls", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const symbols = delta.added.symbols ?? [];
    expect(symbols.length).toBeGreaterThan(0);

    const symbolNames = symbols.map((s) => s.name);
    // From main.go
    expect(symbolNames).toContain("main");
    // From pkg/service.go
    expect(symbolNames).toContain("Service");
    expect(symbolNames).toContain("NewService");
    expect(symbolNames).toContain("(*Service).Hello");
    // From internal/db/db.go
    expect(symbolNames).toContain("Storer");
    expect(symbolNames).toContain("Store");
    expect(symbolNames).toContain("NewStore");

    // Check symbol structure
    const newService = symbols.find((s) => s.name === "NewService");
    expect(newService).toBeDefined();
    expect(newService!.kind).toBe("function");
    expect(newService!.exported).toBe(true);
    expect(newService!.unit_id).toBe("unit:go:pkg");
    expect(newService!.decl.file_id).toBe("file:pkg/service.go");
    expect(newService!.id).toMatch(/^sym:go:pkg#function#NewService#sig:/);

    // main is not exported
    const mainSym = symbols.find((s) => s.name === "main");
    expect(mainSym!.exported).toBe(false);

    // Fields are included
    const storeField = symbols.find((s) => s.name === "store" && s.kind === "field");
    expect(storeField).toBeDefined();
    expect(storeField!.exported).toBe(false);
  }, 30_000);

  test("indexUnits produces call_edges via gopls", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const callEdges = delta.added.call_edges ?? [];
    expect(callEdges.length).toBeGreaterThan(0);

    // main -> NewService call edge
    const mainToNewService = callEdges.find(
      (e) => e.caller_id.includes("#main#") && e.callee_id.includes("#NewService#"),
    );
    expect(mainToNewService).toBeDefined();
    expect(mainToNewService!.dispatch).toBe("static");
    expect(mainToNewService!.site.file_id).toBe("file:main.go");

    // main -> Hello call edge (method name is "(*Service).Hello")
    const mainToHello = callEdges.find(
      (e) => e.caller_id.includes("#main#") && e.callee_id.includes("Hello"),
    );
    expect(mainToHello).toBeDefined();

    // NewService -> NewStore call edge
    const newServiceToNewStore = callEdges.find(
      (e) => e.caller_id.includes("#NewService#") && e.callee_id.includes("#NewStore#"),
    );
    expect(newServiceToNewStore).toBeDefined();
  }, 30_000);

  test("indexUnits produces refs derived from call_edges", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const refs = delta.added.refs ?? [];
    expect(refs.length).toBeGreaterThan(0);

    // Every call edge should have a corresponding ref
    const callEdges = delta.added.call_edges ?? [];
    for (const edge of callEdges) {
      const ref = refs.find(
        (r) => r.from_symbol_id === edge.caller_id && r.to_symbol_id === edge.callee_id,
      );
      expect(ref).toBeDefined();
      expect(ref!.kind).toBe("call");
      expect(ref!.confidence).toBe("certain");
    }
  }, 30_000);

  test("indexUnits produces type_relations via gopls", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const typeRelations = delta.added.type_relations ?? [];
    expect(typeRelations.length).toBeGreaterThan(0);

    // Store implements Storer
    const storeImplsStorer = typeRelations.find(
      (tr) =>
        tr.from_type_id.includes("#Store#") &&
        tr.to_type_id.includes("#Storer#") &&
        tr.kind === "implements",
    );
    expect(storeImplsStorer).toBeDefined();
  }, 30_000);

  test("diagnose runs go vet without errors on clean code", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const diags = await adapter.diagnose(units, {});
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

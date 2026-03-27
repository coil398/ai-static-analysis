import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { PythonLanguageAdapter } from "./language-adapter.ts";
import { exec } from "../shared/index.ts";

const TESTDATA = resolve(import.meta.dir, "testdata");

/**
 * Check whether pyright-langserver is actually working (not just a broken shim).
 *
 * `pyright-langserver --version` always exits with code 1 because it requires
 * --stdio to establish the LSP connection. However, a properly installed binary
 * outputs a specific "Connection input stream is not set" error to stderr, which
 * we use as a positive indicator. A broken pyenv shim or missing install would
 * produce a different error (e.g., "No module named pyright" or "command not found").
 */
async function isPyrightAvailable(): Promise<boolean> {
  for (const cmd of ["pyright-langserver", "basedpyright-langserver"]) {
    const result = await exec([cmd, "--version"]).catch(() => null);
    if (!result) continue;
    // Exit 0: binary supports --version flag (future-proof)
    if (result.exitCode === 0) return true;
    // "Connection input stream": binary ran successfully but needs --stdio
    if (result.stderr.includes("Connection input stream")) return true;
  }
  return false;
}

const hasPyright = await isPyrightAvailable();

describe("PythonLanguageAdapter", () => {
  const adapter = new PythonLanguageAdapter();

  test("detect returns supported for testdata (pyproject.toml)", async () => {
    const result = await adapter.detect(TESTDATA);
    expect(result.supported).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  test("detect returns unsupported for non-python dir", async () => {
    const result = await adapter.detect("/tmp");
    expect(result.confidence).toBeLessThanOrEqual(0.6);
  });

  test("doctor returns ok when python is available", async () => {
    const result = await adapter.doctor();
    expect(result.ok).toBe(true);
    expect(result.missing_tools).not.toContain("python");
  });

  test("doctor notes mention pyright-langserver", async () => {
    const result = await adapter.doctor();
    const allNotes = result.notes.join("\n");
    expect(allNotes).toContain("pyright-langserver");
  });

  test("enumerateUnits finds mypackage", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    expect(units.length).toBeGreaterThanOrEqual(1);

    const unitIds = units.map((u) => u.id);
    expect(unitIds).toContain("unit:py:mypackage");

    const pkg = units.find((u) => u.id === "unit:py:mypackage");
    expect(pkg).toBeDefined();
    expect(pkg!.kind).toBe("py_package");
    expect(pkg!.name).toBe("mypackage");
    expect(pkg!.metadata?.["repo_root"]).toBe(TESTDATA);
  });

  test("indexUnits produces files with hashes", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const fileIds = delta.added.files?.map((f) => f.id) ?? [];
    expect(fileIds).toContain("file:mypackage/__init__.py");
    expect(fileIds).toContain("file:mypackage/service.py");
    expect(fileIds).toContain("file:mypackage/generated.py");

    for (const f of delta.added.files ?? []) {
      expect(f.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  }, 30_000);

  test("indexUnits marks generated files correctly", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const genFile = delta.added.files?.find((f) => f.id === "file:mypackage/generated.py");
    expect(genFile).toBeDefined();
    expect(genFile!.generated).toBe(true);

    const serviceFile = delta.added.files?.find((f) => f.id === "file:mypackage/service.py");
    expect(serviceFile!.generated).toBe(false);
  }, 30_000);

  test.skipIf(!hasPyright)("indexUnits skips generated files from LSP analysis", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    // generated.py must appear in files
    const genFile = delta.added.files?.find((f) => f.id === "file:mypackage/generated.py");
    expect(genFile).toBeDefined();
    expect(genFile!.generated).toBe(true);

    // Symbols from generated.py must NOT be included
    const symbols = delta.added.symbols ?? [];
    const genSymbols = symbols.filter((s) => s.decl.file_id === "file:mypackage/generated.py");
    expect(genSymbols).toHaveLength(0);
  }, 60_000);

  test.skipIf(!hasPyright)("indexUnits produces symbols via pyright", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const symbols = delta.added.symbols ?? [];
    expect(symbols.length).toBeGreaterThan(0);

    const symbolNames = symbols.map((s) => s.name);
    expect(symbolNames).toContain("Greeter");
    expect(symbolNames).toContain("HelloService");
    expect(symbolNames).toContain("create_service");

    // Check symbol structure
    const helloService = symbols.find((s) => s.name === "HelloService");
    expect(helloService).toBeDefined();
    expect(helloService!.kind).toBe("class");
    expect(helloService!.exported).toBe(true);
    expect(helloService!.unit_id).toBe("unit:py:mypackage");
    expect(helloService!.id).toMatch(/^sym:py:mypackage#class#HelloService#sig:/);
    expect(helloService!.decl.file_id).toBe("file:mypackage/service.py");
  }, 60_000);

  test.skipIf(!hasPyright)("indexUnits exported flag: _ prefix is not exported", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const symbols = delta.added.symbols ?? [];

    // Public symbols are exported
    const greeter = symbols.find((s) => s.name === "Greeter");
    expect(greeter?.exported).toBe(true);

    const createService = symbols.find((s) => s.name === "create_service");
    expect(createService?.exported).toBe(true);

    // Symbols starting with _ are not exported
    const privateSyms = symbols.filter((s) => s.name.startsWith("_") && s.name !== "__init__");
    for (const sym of privateSyms) {
      expect(sym.exported).toBe(false);
    }
  }, 60_000);

  test.skipIf(!hasPyright)("indexUnits produces call_edges via pyright", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const callEdges = delta.added.call_edges ?? [];
    expect(callEdges.length).toBeGreaterThan(0);

    // All call edges must have required fields
    for (const edge of callEdges) {
      expect(edge.caller_id).toMatch(/^sym:py:/);
      expect(edge.callee_id).toMatch(/^sym:py:/);
      expect(edge.dispatch).toBe("static");
      expect(edge.site.file_id).toMatch(/^file:/);
    }

    // create_service calls HelloService constructor
    const toHelloService = callEdges.find(
      (e) => e.callee_id.includes("#HelloService#") || e.callee_id.includes("#__init__#"),
    );
    expect(toHelloService).toBeDefined();
  }, 60_000);

  test.skipIf(!hasPyright)("indexUnits produces refs derived from call_edges", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const refs = delta.added.refs ?? [];
    expect(refs.length).toBeGreaterThan(0);

    // Every call edge should have a corresponding call ref
    const callEdges = delta.added.call_edges ?? [];
    for (const edge of callEdges) {
      const ref = refs.find(
        (r) =>
          r.from_symbol_id === edge.caller_id &&
          r.to_symbol_id === edge.callee_id &&
          r.kind === "call",
      );
      expect(ref).toBeDefined();
      expect(ref!.confidence).toBe("certain");
    }
  }, 60_000);

  test.skipIf(!hasPyright)("indexUnits produces type_relations via pyright", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const typeRelations = delta.added.type_relations ?? [];
    expect(typeRelations.length).toBeGreaterThan(0);

    // HelloService implements Greeter
    const implRelation = typeRelations.find(
      (tr) =>
        tr.from_type_id.includes("#HelloService#") &&
        tr.to_type_id.includes("#Greeter#") &&
        tr.kind === "implements",
    );
    expect(implRelation).toBeDefined();
  }, 60_000);

  test("bootstrap returns valid result structure including pyright", async () => {
    const result = await adapter.bootstrap();
    expect(result).toHaveProperty("installed");
    expect(result).toHaveProperty("failed");
    expect(result).toHaveProperty("notes");

    // pyright should appear in installed, notes (already installed), or failed
    const all = [
      ...result.installed,
      ...result.failed.map((f) => f.tool),
      ...result.notes.map((n) => n.split(":")[0]!),
    ];
    expect(all).toContain("pyright");
  }, 120_000);
});

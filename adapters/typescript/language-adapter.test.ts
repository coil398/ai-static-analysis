import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { TypeScriptLanguageAdapter } from "./language-adapter.ts";
import { exec, LspClient } from "../shared/index.ts";

const TESTDATA = resolve(import.meta.dir, "testdata");
// whichTool だけだと shim が存在するが実体がないケースを検出できないため --version で確認
let hasTsServer = false;
try {
  const tsServerVersion = await exec(["typescript-language-server", "--version"]);
  hasTsServer = tsServerVersion.exitCode === 0;
} catch {
  // typescript-language-server not found in PATH
}

describe("TypeScriptLanguageAdapter", () => {
  const adapter = new TypeScriptLanguageAdapter();

  test("detect returns supported for testdata (has tsconfig.json)", async () => {
    const result = await adapter.detect(TESTDATA);
    expect(result.supported).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  test("detect returns unsupported for non-ts dir", async () => {
    const result = await adapter.detect("/tmp");
    expect(result.supported).toBe(false);
    expect(result.confidence).toBe(0);
  });

  test("doctor finds node tool", async () => {
    const result = await adapter.doctor();
    expect(result.ok).toBe(true);
    expect(result.missing_tools).not.toContain("node");
  });

  test("doctor reports typescript-language-server status", async () => {
    const result = await adapter.doctor();
    const allNotes = result.notes.join("\n");
    expect(allNotes).toContain("typescript-language-server");
  });

  test("enumerateUnits returns units for testdata", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    expect(units.length).toBeGreaterThanOrEqual(1);

    const unitIds = units.map((u) => u.id);
    expect(unitIds).toContain("unit:ts:.");

    const rootUnit = units.find((u) => u.id === "unit:ts:.");
    expect(rootUnit).toBeDefined();
    expect(rootUnit!.kind).toBe("ts_project");
  });

  test("indexUnits produces files with hashes", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const files = delta.added.files ?? [];
    expect(files.length).toBeGreaterThan(0);

    // All files should have sha256 hashes
    for (const f of files) {
      expect(f.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }

    // generated.ts should be marked as generated
    const genFile = files.find((f) => f.path.includes("generated.ts"));
    expect(genFile).toBeDefined();
    expect(genFile?.generated).toBe(true);

    // service.ts should not be generated
    const serviceFile = files.find((f) => f.path.includes("service.ts"));
    expect(serviceFile).toBeDefined();
    expect(serviceFile?.generated).toBe(false);
  }, 30_000);

  test("indexUnits returns valid delta structure", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    expect(delta).toHaveProperty("added");
    expect(delta).toHaveProperty("removed");
    expect(delta.added).toHaveProperty("units");
    expect(delta.added).toHaveProperty("files");
    expect(delta.added).toHaveProperty("deps");
    expect(delta.added).toHaveProperty("symbols");
  }, 30_000);

  test.skipIf(!hasTsServer)("indexUnits produces symbols via typescript-language-server", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const symbols = delta.added.symbols ?? [];
    expect(symbols.length).toBeGreaterThan(0);

    const symbolNames = symbols.map((s) => s.name);
    // From src/db.ts
    expect(symbolNames).toContain("Storer");
    expect(symbolNames).toContain("Store");
    expect(symbolNames).toContain("newStore");
    // From src/service.ts
    expect(symbolNames).toContain("Service");
    expect(symbolNames).toContain("newService");

    // Check symbol structure
    const storer = symbols.find((s) => s.name === "Storer");
    expect(storer).toBeDefined();
    expect(storer!.kind).toBe("interface");
    expect(storer!.exported).toBe(true);
    expect(storer!.id).toMatch(/^sym:ts:.*#interface#Storer#sig:/);

    const store = symbols.find((s) => s.name === "Store");
    expect(store).toBeDefined();
    expect(store!.kind).toBe("class");
    expect(store!.exported).toBe(true);

    // run() in main.ts is not exported
    const runFn = symbols.find((s) => s.name === "run");
    expect(runFn).toBeDefined();
    expect(runFn!.exported).toBe(false);
  }, 60_000);

  test.skipIf(!hasTsServer)("indexUnits correct exported judgment for symbols", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const symbols = delta.added.symbols ?? [];

    // Exported symbols: Storer (interface), Store (class), newStore (function),
    //                   Service (class), newService (function)
    const exportedExpected = ["Storer", "Store", "newStore", "Service", "newService"];
    for (const name of exportedExpected) {
      const sym = symbols.find((s) => s.name === name);
      expect(sym).toBeDefined();
      expect(sym!.exported).toBe(true);
    }

    // Non-exported symbols: run (function in main.ts — no export keyword)
    const runFn = symbols.find((s) => s.name === "run");
    expect(runFn).toBeDefined();
    expect(runFn!.exported).toBe(false);
  }, 60_000);

  test.skipIf(!hasTsServer)("indexUnits excludes generated files from LSP analysis", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    // generated.ts should be in files
    const genFile = delta.added.files?.find((f) => f.path.includes("generated.ts"));
    expect(genFile).toBeDefined();
    expect(genFile?.generated).toBe(true);

    // Symbols from generated.ts should not be included
    const symbols = delta.added.symbols ?? [];
    const genSymbols = symbols.filter((s) => s.decl.file_id.includes("generated.ts"));
    expect(genSymbols).toHaveLength(0);
  }, 60_000);

  test.skipIf(!hasTsServer)("indexUnits produces call_edges via typescript-language-server", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const callEdges = delta.added.call_edges ?? [];
    expect(callEdges.length).toBeGreaterThan(0);

    // All call edges should have dispatch field
    for (const edge of callEdges) {
      expect(edge.dispatch).toBe("static");
      expect(edge.caller_id).toMatch(/^sym:ts:/);
      expect(edge.callee_id).toMatch(/^sym:ts:/);
    }
  }, 60_000);

  test.skipIf(!hasTsServer)("indexUnits produces refs derived from call_edges", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const refs = delta.added.refs ?? [];
    expect(refs.length).toBeGreaterThan(0);

    // Every call edge should have a corresponding call ref
    const callEdges = delta.added.call_edges ?? [];
    for (const edge of callEdges) {
      const ref = refs.find(
        (r) => r.from_symbol_id === edge.caller_id && r.to_symbol_id === edge.callee_id,
      );
      expect(ref).toBeDefined();
      expect(ref!.kind).toBe("call");
      expect(ref!.confidence).toBe("certain");
    }
  }, 60_000);

  test.skipIf(!hasTsServer)("indexUnits produces type_relations via typescript-language-server", async () => {
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
  }, 60_000);

  test("bootstrap returns valid structure", async () => {
    const result = await adapter.bootstrap();
    expect(result).toHaveProperty("installed");
    expect(result).toHaveProperty("failed");
    expect(result).toHaveProperty("notes");
  }, 120_000);

  test("setExternalLspClient allows injecting an external client", async () => {
    const adapterWithClient = new TypeScriptLanguageAdapter();
    // null を設定してデフォルト動作に戻せること
    adapterWithClient.setExternalLspClient(null);
    expect(adapterWithClient["externalClient"]).toBeNull();
  });

  test.skipIf(!hasTsServer)("setExternalLspClient uses provided client without shutdown", async () => {
    const adapterWithClient = new TypeScriptLanguageAdapter();
    const externalClient = new LspClient(["typescript-language-server", "--stdio"], TESTDATA);
    adapterWithClient.setExternalLspClient(externalClient);

    try {
      const units = await adapterWithClient.enumerateUnits(TESTDATA, {});
      const delta = await adapterWithClient.indexUnits(units, {});
      // 外部クライアントを使っても正常に解析できること
      expect(delta.added.files?.length).toBeGreaterThan(0);
      if (hasTsServer) {
        expect(delta.added.symbols?.length).toBeGreaterThan(0);
      }
    } finally {
      // 外部クライアントを手動で shutdown する
      await externalClient.shutdown();
    }
  }, 60_000);
});

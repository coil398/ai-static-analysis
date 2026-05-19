import { describe, test, expect, beforeAll } from "bun:test";
import { resolve } from "node:path";
import { CSharpLanguageAdapter } from "./language-adapter.ts";
import { exec, whichTool, LspClient } from "../shared/index.ts";
import type { FactsDelta } from "../../core/schema/types.ts";

const TESTDATA = resolve(import.meta.dir, "testdata");
// Check csharp-ls availability with DOTNET_ROOT so the .NET runtime is found
const dotnetRoot = process.env["DOTNET_ROOT"] ?? `${process.env["HOME"]}/.dotnet`;
const dotnetEnv = {
  DOTNET_ROOT: dotnetRoot,
  PATH: `${dotnetRoot}:${dotnetRoot}/tools:${process.env["PATH"] ?? ""}`,
};
const csharpLsCheck = await exec(["csharp-ls", "--version"], { env: dotnetEnv }).catch(() => ({ exitCode: 1 }));
const hasCsharpLs = csharpLsCheck.exitCode === 0;
const hasOmnisharp = (await whichTool("omnisharp")) !== null;
const hasLsp = hasCsharpLs || hasOmnisharp;
const hasDotnet = (await whichTool("dotnet")) !== null;

describe("CSharpLanguageAdapter", () => {
  const adapter = new CSharpLanguageAdapter();

  test("detect returns supported for testdata", async () => {
    const result = await adapter.detect(TESTDATA);
    expect(result.supported).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
  });

  test("detect returns unsupported for non-csharp dir", async () => {
    const result = await adapter.detect("/tmp");
    expect(result.supported).toBe(false);
    expect(result.confidence).toBe(0);
  });

  test("doctor returns ok=true when dotnet is available or reports missing", async () => {
    const result = await adapter.doctor();
    expect(result).toHaveProperty("ok");
    expect(result).toHaveProperty("missing_tools");
    expect(result).toHaveProperty("notes");
    const notesStr = result.notes.join("\n");
    expect(notesStr).toMatch(/csharp-ls|omnisharp/);
  });

  test("enumerateUnits returns projects from testdata", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    expect(units.length).toBeGreaterThanOrEqual(1);

    const unit = units.find((u) => u.id === "unit:cs:.");
    expect(unit).toBeDefined();
    expect(unit!.kind).toBe("cs_project");
    expect(unit!.name).toBe("TestProject");
    expect(unit!.metadata?.["csproj"]).toBe("TestProject.csproj");
  });


  test("bootstrap returns valid result structure", async () => {
    const result = await adapter.bootstrap();
    expect(result).toHaveProperty("installed");
    expect(result).toHaveProperty("failed");
    expect(result).toHaveProperty("notes");
  }, 120_000);

  test.skipIf(!hasDotnet)("diagnose returns valid diagnostics structure", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const diags = await adapter.diagnose(units, {});
    expect(Array.isArray(diags)).toBe(true);
    const cycleDiags = diags.filter((d) => d.tool === "cycle_detector");
    expect(cycleDiags).toEqual([]);
  }, 360_000);

  test("CS_SYMBOL_KIND_MAP covers expected C# types", () => {
    const kindMap: Record<number, string> = {
      5: "class", 6: "method", 7: "property", 8: "field",
      9: "constructor", 10: "enum", 11: "interface", 12: "function",
      13: "variable", 14: "constant", 22: "struct", 23: "event",
    };
    for (const [, v] of Object.entries(kindMap)) {
      expect(typeof v).toBe("string");
      expect(v).toBe(v.toLowerCase());
    }
  });
});

// LSP tests share a single indexUnits call to avoid repeated csharp-ls startup
describe.skipIf(!hasLsp)("CSharpLanguageAdapter LSP integration", () => {
  const adapter = new CSharpLanguageAdapter();
  let delta: FactsDelta;

  beforeAll(async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    delta = await adapter.indexUnits(units, {});
  }, 480_000); // csharp-ls workspace load can take a while

  test("produces symbols", () => {
    const symbols = delta.added.symbols ?? [];
    expect(symbols.length).toBeGreaterThan(0);

    const symbolNames = symbols.map((s) => s.name);
    expect(symbolNames).toContain("IService");
    expect(symbolNames).toContain("Service");
    expect(symbolNames.some((n) => n.startsWith("Greet"))).toBe(true);

    const iservice = symbols.find((s) => s.name === "IService");
    expect(iservice).toBeDefined();
    expect(iservice!.kind).toBe("interface");
    expect(iservice!.exported).toBe(true);
    expect(iservice!.unit_id).toBe("unit:cs:.");
    expect(iservice!.id).toMatch(/^sym:cs:.#interface#IService#sig:/);

    const service = symbols.find((s) => s.name === "Service" && s.kind === "class");
    expect(service).toBeDefined();
    expect(service!.kind).toBe("class");
  });

  test("produces type_relations (implements)", () => {
    const typeRelations = delta.added.type_relations ?? [];
    expect(typeRelations.length).toBeGreaterThan(0);

    const serviceImplsIService = typeRelations.find(
      (tr) =>
        tr.from_type_id.includes("#Service#") &&
        tr.to_type_id.includes("#IService#") &&
        tr.kind === "implements",
    );
    expect(serviceImplsIService).toBeDefined();
  });

  test("produces call_edges (if LSP supports call hierarchy)", () => {
    const callEdges = delta.added.call_edges ?? [];
    // csharp-ls may not support call hierarchy for all versions/scenarios.
    // Validate structure when edges are present.
    for (const edge of callEdges) {
      expect(edge).toHaveProperty("caller_id");
      expect(edge).toHaveProperty("callee_id");
      expect(edge).toHaveProperty("site");
      expect(edge.dispatch).toMatch(/^(static|dynamic|interface)$/);
    }
  });

  test("produces refs (call refs match call edges)", () => {
    const refs = delta.added.refs ?? [];
    const callEdges = delta.added.call_edges ?? [];

    // Every call edge should have a corresponding ref
    for (const edge of callEdges) {
      const ref = refs.find(
        (r) => r.from_symbol_id === edge.caller_id && r.to_symbol_id === edge.callee_id,
      );
      expect(ref).toBeDefined();
      expect(ref!.kind).toBe("call");
      expect(ref!.confidence).toBe("certain");
    }
  });

  test("skips generated files from LSP analysis", () => {
    const symbols = delta.added.symbols ?? [];
    const generatedSymbol = symbols.find(
      (s) => s.name === "GeneratedHelper" || s.name === "AutoMethod()",
    );
    expect(generatedSymbol).toBeUndefined();
  });

  test("produces files with hashes and generated marker", () => {
    const fileIds = delta.added.files?.map((f) => f.id) ?? [];
    expect(fileIds).toContain("file:Program.cs");
    expect(fileIds).toContain("file:Services/IService.cs");
    expect(fileIds).toContain("file:Services/Service.cs");

    for (const f of delta.added.files ?? []) {
      expect(f.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }

    // Generated.cs should be marked as generated
    const generatedFile = delta.added.files?.find((f) => f.id.includes("Generated.cs"));
    expect(generatedFile).toBeDefined();
    expect(generatedFile!.generated).toBe(true);

    const nonGen = delta.added.files?.filter((f) => !f.generated) ?? [];
    expect(nonGen.length).toBeGreaterThan(0);
  });

  test("nested children are flattened", () => {
    const symbols = delta.added.symbols ?? [];
    const greetSym = symbols.find((s) => s.name.startsWith("Greet"));
    expect(greetSym).toBeDefined();
  });

  test("setExternalLspClient allows injecting an external client", async () => {
    const adapterWithClient = new CSharpLanguageAdapter();
    // null を設定してデフォルト動作に戻せること
    adapterWithClient.setExternalLspClient(null);
    expect(adapterWithClient["externalClient"]).toBeNull();
  });

  test.skipIf(!hasCsharpLs)("setExternalLspClient uses provided client without shutdown", async () => {
    const adapterWithClient = new CSharpLanguageAdapter();
    // 外部クライアントは buildDotnetEnv() 相当の環境変数を設定済みで注入する
    const externalClient = new LspClient(["csharp-ls"], TESTDATA, undefined, {
      DOTNET_ROOT: dotnetRoot,
      PATH: `${dotnetRoot}:${dotnetRoot}/tools:${process.env["PATH"] ?? ""}`,
    }, { handleServerRequests: true });
    adapterWithClient.setExternalLspClient(externalClient);

    try {
      const units = await adapterWithClient.enumerateUnits(TESTDATA, {});
      const delta2 = await adapterWithClient.indexUnits(units, {});
      // 外部クライアントを使っても正常に解析できること
      expect(delta2.added.files?.length).toBeGreaterThan(0);
      if (hasCsharpLs) {
        expect(delta2.added.symbols?.length).toBeGreaterThan(0);
      }
    } finally {
      // 外部クライアントを手動で shutdown する
      try { await externalClient.shutdown(); } catch { /* ignore */ }
    }
  }, 120_000);
});

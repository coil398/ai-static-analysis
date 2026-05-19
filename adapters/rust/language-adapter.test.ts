import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { RustLanguageAdapter } from "./language-adapter.ts";
import { exec, whichTool, LspClient } from "../shared/index.ts";

const TESTDATA = resolve(import.meta.dir, "testdata");

// rust-analyzer の存在確認は --version の終了コードで行う
async function checkRustAnalyzer(): Promise<boolean> {
  try {
    const path = await whichTool("rust-analyzer");
    if (!path) return false;
    const result = await exec(["rust-analyzer", "--version"]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

const hasRustAnalyzer = await checkRustAnalyzer();
const hasCargo = await whichTool("cargo") !== null;
const hasRustc = await whichTool("rustc") !== null;
describe("RustLanguageAdapter", () => {
  const adapter = new RustLanguageAdapter();

  test("detect returns supported for testdata", async () => {
    const result = await adapter.detect(TESTDATA);
    expect(result.supported).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  test("detect returns unsupported for non-rust dir", async () => {
    const result = await adapter.detect("/tmp");
    expect(result.supported).toBe(false);
    expect(result.confidence).toBe(0);
  });

  test.skipIf(!hasRustc || !hasCargo)("doctor finds rustc and cargo", async () => {
    const result = await adapter.doctor();
    expect(result.ok).toBe(true);
    expect(result.missing_tools).not.toContain("rustc");
    expect(result.missing_tools).not.toContain("cargo");
  }, 30_000);

  test.skipIf(!hasRustc)("doctor notes rust-analyzer presence", async () => {
    const result = await adapter.doctor();
    const allNotes = result.notes.join("\n");
    expect(allNotes).toContain("rust-analyzer");
  }, 30_000);

  test.skipIf(!hasCargo)("enumerateUnits returns crates", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    expect(units.length).toBeGreaterThanOrEqual(1);
    expect(units[0]!.kind).toBe("rust_crate");
    expect(units[0]!.name).toBe("testproject");
    expect(units[0]!.id).toMatch(/^unit:rs:/);
  }, 30_000);

  test.skipIf(!hasCargo)("indexUnits produces files", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const fileIds = delta.added.files?.map((f) => f.id) ?? [];
    expect(fileIds).toContain("file:src/main.rs");
    expect(fileIds).toContain("file:src/service.rs");

    for (const f of delta.added.files ?? []) {
      expect(f.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  }, 60_000);

  test.skipIf(!hasCargo)("indexUnits skips generated files from LSP analysis", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    // generated.rs は files に含まれること
    const genFile = delta.added.files?.find((f) => f.id === "file:src/generated.rs");
    expect(genFile).toBeDefined();
    expect(genFile?.generated).toBe(true);

    if (hasRustAnalyzer) {
      // generated ファイルから来たシンボルは LSP 解析対象外
      const symbols = delta.added.symbols ?? [];
      const genSymbols = symbols.filter((s) => s.decl.file_id === "file:src/generated.rs");
      expect(genSymbols).toHaveLength(0);
    }
  }, 60_000);

  test.skipIf(!hasCargo || !hasRustAnalyzer)("indexUnits produces symbols via LSP", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const symbols = delta.added.symbols ?? [];
    expect(symbols.length).toBeGreaterThan(0);

    const symbolNames = symbols.map((s) => s.name);
    expect(symbolNames).toContain("Greeter");
    expect(symbolNames).toContain("EnglishGreeter");

    // trait のチェック
    const greeterTrait = symbols.find((s) => s.name === "Greeter");
    expect(greeterTrait).toBeDefined();
    expect(greeterTrait!.kind).toBe("trait");
    expect(greeterTrait!.id).toMatch(/^sym:rs:.*#trait#Greeter#sig:/);
    expect(greeterTrait!.decl.file_id).toBe("file:src/service.rs");

    // struct のチェック
    const englishGreeter = symbols.find((s) => s.name === "EnglishGreeter");
    expect(englishGreeter).toBeDefined();
    expect(englishGreeter!.kind).toBe("struct");
    expect(englishGreeter!.id).toMatch(/^sym:rs:.*#struct#EnglishGreeter#sig:/);

    // メソッドのチェック（impl ブロックから抽出されること）
    const newFn = symbols.find((s) => s.name === "EnglishGreeter::new");
    expect(newFn).toBeDefined();
    expect(newFn!.kind).toBe("function");

    // constant のチェック
    const constSym = symbols.find((s) => s.name === "DEFAULT_GREETING");
    expect(constSym).toBeDefined();
    expect(constSym!.kind).toBe("constant");
  }, 60_000);

  test.skipIf(!hasCargo || !hasRustAnalyzer)("indexUnits produces call edges via LSP", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const callEdges = delta.added.call_edges ?? [];
    expect(callEdges.length).toBeGreaterThan(0);

    for (const edge of callEdges) {
      expect(edge).toHaveProperty("caller_id");
      expect(edge).toHaveProperty("callee_id");
      expect(edge.dispatch).toBe("static");
    }

    // main → EnglishGreeter::new の call edge が存在すること
    const mainToNew = callEdges.find(
      (e) => e.caller_id.includes("#main#") && e.callee_id.includes("EnglishGreeter::new"),
    );
    expect(mainToNew).toBeDefined();
  }, 60_000);

  test.skipIf(!hasCargo || !hasRustAnalyzer)("indexUnits produces refs via LSP", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const refs = delta.added.refs ?? [];
    expect(refs.length).toBeGreaterThan(0);

    // call edge から派生した call 参照が存在すること
    const callRefs = refs.filter((r) => r.kind === "call");
    expect(callRefs.length).toBeGreaterThan(0);
    for (const r of callRefs) {
      expect(r.confidence).toBe("certain");
    }

    // call 以外の参照（type_ref, field_access, reference）も存在すること
    const nonCallRefs = refs.filter((r) => r.kind !== "call");
    expect(nonCallRefs.length).toBeGreaterThan(0);

    // call_edges と refs の対応確認
    const callEdges = delta.added.call_edges ?? [];
    for (const edge of callEdges) {
      const ref = refs.find(
        (r) => r.from_symbol_id === edge.caller_id && r.to_symbol_id === edge.callee_id,
      );
      expect(ref).toBeDefined();
      expect(ref!.kind).toBe("call");
    }
  }, 60_000);

  test.skipIf(!hasCargo || !hasRustAnalyzer)("indexUnits produces type relations via LSP", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});

    const typeRelations = delta.added.type_relations ?? [];
    expect(typeRelations.length).toBeGreaterThan(0);

    // EnglishGreeter が Greeter を implements すること
    const implRelation = typeRelations.find(
      (tr) => tr.from_type_id.includes("#EnglishGreeter#") && tr.to_type_id.includes("#Greeter#") && tr.kind === "implements",
    );
    expect(implRelation).toBeDefined();
  }, 60_000);

  test.skipIf(!hasRustc)("bootstrap returns valid structure", async () => {
    const result = await adapter.bootstrap();
    expect(result).toHaveProperty("installed");
    expect(result).toHaveProperty("failed");
    expect(result).toHaveProperty("notes");
  }, 180_000);

  test.skipIf(!hasCargo)("bootstrap includes rust-analyzer in components", async () => {
    const result = await adapter.bootstrap();
    const allMessages = [
      ...result.installed,
      ...result.failed.map((f) => f.tool),
      ...result.notes,
    ].join("\n");
    expect(allMessages).toContain("rust-analyzer");
  }, 180_000);

  test("setExternalLspClient allows injecting an external client", async () => {
    const adapterWithClient = new RustLanguageAdapter();
    // null を設定してデフォルト動作に戻せること
    adapterWithClient.setExternalLspClient(null);
    expect(adapterWithClient["externalClient"]).toBeNull();
  });

  test.skipIf(!hasRustAnalyzer)("setExternalLspClient uses provided client without shutdown", async () => {
    const adapterWithClient = new RustLanguageAdapter();
    const externalClient = new LspClient(["rust-analyzer"], TESTDATA);
    adapterWithClient.setExternalLspClient(externalClient);

    try {
      const units = await adapterWithClient.enumerateUnits(TESTDATA, {});
      const delta = await adapterWithClient.indexUnits(units, {});
      // 外部クライアントを使っても正常に解析できること
      expect(delta.added.files?.length).toBeGreaterThan(0);
      if (hasRustAnalyzer) {
        expect(delta.added.symbols?.length).toBeGreaterThan(0);
      }
    } finally {
      // 外部クライアントを手動で shutdown する
      await externalClient.shutdown();
    }
  }, 60_000);
});

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  ElixirLanguageAdapter,
  parseModuleDeclarations,
  parseModuleReferences,
  parseTopLevelDefs,
  parseCredoJson,
} from "./index.ts";
import { whichTool } from "../shared/index.ts";

const TESTDATA = resolve(import.meta.dir, "testdata");
const hasElixirLs =
  (await whichTool("elixir-ls")) !== null ||
  (await whichTool("language_server.sh")) !== null;
const LSP_TIMEOUT_MS = 240_000;

describe("ElixirLanguageAdapter", () => {
  const adapter = new ElixirLanguageAdapter();

  test("detect returns supported for a mix.exs-rooted project", async () => {
    const r = await adapter.detect(TESTDATA);
    expect(r.supported).toBe(true);
    expect(r.confidence).toBe(1.0);
  });

  test("detect returns unsupported for /tmp", async () => {
    const r = await adapter.detect("/tmp");
    expect(r.supported).toBe(false);
  });

  test("doctor exposes shape-only assertions (env-independent)", async () => {
    const r = await adapter.doctor();
    expect(Array.isArray(r.missing_tools)).toBe(true);
    expect(Array.isArray(r.notes)).toBe(true);
  });

  test("enumerateUnits collapses single mix.exs to unit:elixir:.", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    expect(units).toHaveLength(1);
    expect(units[0]!.id).toBe("unit:elixir:.");
    expect(units[0]!.kind).toBe("elixir_app");
  });

  test(
    "indexUnits collects lib/*.ex files",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const delta = await adapter.indexUnits(units, {});
      const fileIds = (delta.added.files ?? []).map((f) => f.id).sort();
      expect(fileIds).toContain("file:lib/greet.ex");
      expect(fileIds).toContain("file:lib/main.ex");
    },
    LSP_TIMEOUT_MS,
  );

  test(
    "indexUnits emits at least defmodule + def symbols via the parser fallback",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const delta = await adapter.indexUnits(units, {});
      const names = (delta.added.symbols ?? []).map((s) => s.name);
      // defmodule Testproject.Greet → module symbol name = "Testproject.Greet"
      expect(names.some((n) => n.includes("Greet"))).toBe(true);
      // greet/1 + run/0 must appear as function symbols.
      expect(names.some((n) => n === "greet" || n.startsWith("greet"))).toBe(true);
    },
    LSP_TIMEOUT_MS,
  );

  test(
    "file hashes are sha256:<hex>",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const delta = await adapter.indexUnits(units, {});
      for (const f of delta.added.files ?? []) {
        expect(f.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      }
    },
    LSP_TIMEOUT_MS,
  );

  test(
    "diagnose returns an array",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const diags = await adapter.diagnose(units, {});
      expect(Array.isArray(diags)).toBe(true);
    },
    LSP_TIMEOUT_MS,
  );

  test.skipIf(!hasElixirLs)(
    "indexUnits (LSP) produces module + function symbols via elixir-ls",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const delta = await adapter.indexUnits(units, {});
      // elixir-ls requires the project to be compiled (mix deps.get +
      // mix compile) before documentSymbol returns useful data. In CI we
      // pre-compile testdata; locally, the adapter falls back to its
      // parser path. Either way at least one module or function symbol
      // must be surfaced.
      const kinds = new Set((delta.added.symbols ?? []).map((s) => s.kind));
      expect(
        kinds.has("module") || kinds.has("function") || kinds.has("namespace"),
      ).toBe(true);
    },
    LSP_TIMEOUT_MS,
  );
});

describe("parseModuleDeclarations", () => {
  test("captures top-level and nested defmodule names", () => {
    const src = `
      defmodule Foo do
        defmodule Foo.Bar do
          def baz, do: 1
        end
      end
    `;
    expect(parseModuleDeclarations(src).sort()).toEqual(["Foo", "Foo.Bar"]);
  });
});

describe("parseModuleReferences", () => {
  test("captures alias / import / use / require single forms", () => {
    const src = `
      defmodule X do
        alias Foo.Bar
        import Foo.Baz
        use GenServer
        require Logger
      end
    `;
    expect(parseModuleReferences(src).sort()).toEqual([
      "Foo.Bar",
      "Foo.Baz",
      "GenServer",
      "Logger",
    ]);
  });

  test("expands alias Foo.{Bar, Baz} into multiple references", () => {
    const src = `
      defmodule X do
        alias Foo.{Bar, Baz, Qux}
      end
    `;
    expect(parseModuleReferences(src).sort()).toEqual([
      "Foo.Bar",
      "Foo.Baz",
      "Foo.Qux",
    ]);
  });
});

describe("parseTopLevelDefs", () => {
  test("emits module + def + defp", () => {
    const src = `
defmodule Foo do
  def public_fun do
    1
  end
  defp private_fun do
    2
  end
end
`;
    const syms = parseTopLevelDefs(src, "unit:elixir:.", "lib/foo.ex");
    const pairs = syms.map((s) => `${s.kind}:${s.name}:${s.exported}`).sort();
    expect(pairs).toContain("module:Foo:true");
    expect(pairs).toContain("function:public_fun:true");
    expect(pairs).toContain("function:private_fun:false");
  });
});

describe("parseCredoJson", () => {
  test("converts credo issues into Diagnostic entries", () => {
    const stdout = JSON.stringify({
      issues: [
        {
          category: "readability",
          check: "Credo.Check.Readability.ModuleDoc",
          filename: "/repo/lib/foo.ex",
          line_no: 1,
          column: 1,
          priority: 7,
          message: "Modules should have a @moduledoc tag",
        },
      ],
    });
    const diags = parseCredoJson(stdout, "/repo");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      file_id: "file:lib/foo.ex",
      position: { line: 1, column: 1 },
      severity: "warning",
      tool: "credo",
    });
  });
  test("returns empty array on malformed JSON", () => {
    expect(parseCredoJson("not json", "/repo")).toEqual([]);
  });
});

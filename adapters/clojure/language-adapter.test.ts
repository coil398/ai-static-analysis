import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ClojureLanguageAdapter,
  parseNamespace,
  parseRequires,
  parseTopLevelDefs,
  parseProtocolRelations,
  parseCljKondoJson,
  extractSourcePaths,
} from "./index.ts";
import { whichTool } from "../shared/index.ts";

const TESTDATA = resolve(import.meta.dir, "testdata");
const hasClojureLsp = (await whichTool("clojure-lsp")) !== null;
const LSP_TIMEOUT_MS = 180_000;

describe("ClojureLanguageAdapter", () => {
  const adapter = new ClojureLanguageAdapter();

  test("detect returns supported for a deps.edn project", async () => {
    const r = await adapter.detect(TESTDATA);
    expect(r.supported).toBe(true);
    expect(r.confidence).toBe(1.0);
  });

  test("detect returns unsupported for an empty dir", async () => {
    const empty = await mkdtemp(join(tmpdir(), "clj-detect-"));
    try {
      const r = await adapter.detect(empty);
      expect(r.supported).toBe(false);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("doctor exposes missing_tools and notes arrays", async () => {
    const r = await adapter.doctor();
    expect(Array.isArray(r.missing_tools)).toBe(true);
    expect(Array.isArray(r.notes)).toBe(true);
  });

  test("enumerateUnits returns a single project unit for a deps.edn root", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    expect(units).toHaveLength(1);
    expect(units[0]!.id).toBe("unit:clojure:.");
    expect(units[0]!.kind).toBe("clojure_project");
    expect((units[0]!.metadata?.["source_paths"] as string[])[0]).toBe("src");
  });

  test(
    "indexUnits collects .clj files and (:require) gives intra-unit deps",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const delta = await adapter.indexUnits(units, {});
      const fileIds = (delta.added.files ?? []).map((f) => f.id).sort();
      expect(fileIds).toContain("file:src/myapp/lib/greet.clj");
      expect(fileIds).toContain("file:src/myapp/app/main.clj");
      // testdata has a single unit, so cross-unit deps are not expected. The
      // adapter must still return an array (possibly empty) without throwing.
      expect(Array.isArray(delta.added.deps)).toBe(true);
    },
    LSP_TIMEOUT_MS,
  );

  test(
    "indexUnits emits at least the top-level defn symbols (parser fallback or LSP)",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const delta = await adapter.indexUnits(units, {});
      const names = (delta.added.symbols ?? []).map((s) => s.name);
      expect(names).toContain("greet");
      // -main starts with a dash; we treat it as not exported via the
      // fallback heuristic.
      expect(names.some((n) => n === "-main" || n === "main")).toBe(true);
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
    "diagnose returns an array (empty here — no cycles in single-unit testdata)",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const diags = await adapter.diagnose(units, {});
      expect(Array.isArray(diags)).toBe(true);
    },
    LSP_TIMEOUT_MS,
  );

  test.skipIf(!hasClojureLsp)(
    "indexUnits (LSP) surfaces namespace + function symbols via clojure-lsp",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const delta = await adapter.indexUnits(units, {});
      const kinds = new Set((delta.added.symbols ?? []).map((s) => s.kind));
      // clojure-lsp emits 'namespace' for ns + 'function' for defn.
      expect(
        kinds.has("function") || kinds.has("namespace") || kinds.has("var"),
      ).toBe(true);
    },
    LSP_TIMEOUT_MS,
  );
});

describe("parseNamespace", () => {
  test("captures the ns form at the top of a file", () => {
    expect(parseNamespace("(ns myapp.lib.greet)\n\n(defn foo [] 1)")).toBe(
      "myapp.lib.greet",
    );
  });
  test("returns null when no ns form is present", () => {
    expect(parseNamespace("(defn foo [] 1)")).toBeNull();
  });
});

describe("parseRequires", () => {
  test("captures vector and bare-symbol forms within (:require ...)", () => {
    const src = `
      (ns myapp.app
        (:require [myapp.lib.greet :as g]
                  [clojure.string :refer [join]]
                  myapp.lib.util))
    `;
    const reqs = parseRequires(src).sort();
    expect(reqs).toEqual([
      "clojure.string",
      "myapp.lib.greet",
      "myapp.lib.util",
    ]);
  });

  test("returns empty array when no require form is present", () => {
    expect(parseRequires("(ns simple) (defn foo [] 1)")).toEqual([]);
  });
});

describe("parseTopLevelDefs", () => {
  test("emits defn / def with 1-based positions", () => {
    const src = `(ns foo)\n\n(defn bar [] 1)\n(def baz 2)\n`;
    const syms = parseTopLevelDefs(src, "unit:clojure:.", "foo.clj");
    const names = syms.map((s) => `${s.kind}:${s.name}`).sort();
    expect(names).toEqual(["function:bar", "var:baz"]);
    const bar = syms.find((s) => s.name === "bar")!;
    expect(bar.decl.position.line).toBe(3);
    expect(bar.decl.position.column).toBeGreaterThan(0);
    expect(bar.metadata?.["namespace"]).toBe("foo");
  });

  test("defn- (private) names are still emitted but exported=false rule preserved by the fallback heuristic only flags dash-prefixed names", () => {
    const src = `(ns x)\n(defn -private [] 1)\n(defn pub [] 2)\n`;
    const syms = parseTopLevelDefs(src, "unit:clojure:.", "x.clj");
    const priv = syms.find((s) => s.name === "-private")!;
    const pub = syms.find((s) => s.name === "pub")!;
    expect(priv.exported).toBe(false);
    expect(pub.exported).toBe(true);
  });
});

describe("extractSourcePaths", () => {
  test("recovers deps.edn :paths", () => {
    expect(extractSourcePaths(`{:paths ["src" "resources"]}`, "deps.edn"))
      .toEqual(["src", "resources"]);
  });
  test("recovers project.clj :source-paths", () => {
    expect(
      extractSourcePaths(`(defproject foo "1" :source-paths ["lib" "core"])`, "project.clj"),
    ).toEqual(["lib", "core"]);
  });
  test("defaults to ['src'] when nothing matches", () => {
    expect(extractSourcePaths("{}", "deps.edn")).toEqual(["src"]);
  });
});

describe("parseProtocolRelations", () => {
  test("emits interface symbol for defprotocol and class symbol for defrecord", () => {
    const src = `
(ns myapp.lib.protocols)

(defprotocol Greeter
  "Protocol for greeting."
  (greet [this name] "Returns a greeting for the given name."))

(defrecord ConsoleGreeter []
  Greeter
  (greet [_this name]
    (str "Hello, " name "!")))
`;
    const { symbols, typeRelations } = parseProtocolRelations(
      src,
      "unit:clojure:.",
      "src/myapp/lib/protocols.clj",
    );
    const kinds = symbols.map((s) => `${s.kind}:${s.name}`).sort();
    expect(kinds).toContain("interface:Greeter");
    expect(kinds).toContain("class:ConsoleGreeter");
    expect(typeRelations).toHaveLength(1);
    expect(typeRelations[0]!.kind).toBe("implements");
    expect(typeRelations[0]!.from_type_id).toContain("ConsoleGreeter");
    expect(typeRelations[0]!.to_type_id).toContain("Greeter");
  });

  test("returns empty when no protocols or records are present", () => {
    const src = `(ns simple)\n(defn greet [name] (str "Hi " name))`;
    const { symbols, typeRelations } = parseProtocolRelations(
      src,
      "unit:clojure:.",
      "src/simple.clj",
    );
    expect(symbols).toHaveLength(0);
    expect(typeRelations).toHaveLength(0);
  });

  test("handles defprotocol without a defrecord implementation", () => {
    const src = `
(ns myapp.proto)
(defprotocol Printable
  (render [this]))
`;
    const { symbols, typeRelations } = parseProtocolRelations(
      src,
      "unit:clojure:.",
      "src/myapp/proto.clj",
    );
    expect(symbols.some((s) => s.kind === "interface" && s.name === "Printable")).toBe(true);
    expect(typeRelations).toHaveLength(0);
  });

  test("indexUnits emits type_relations for protocols.clj testdata", async () => {
    const adapter = new ClojureLanguageAdapter();
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});
    const rels = delta.added.type_relations ?? [];
    // protocols.clj has ConsoleGreeter implementing Greeter
    expect(rels.some((r) => r.kind === "implements")).toBe(true);
  }, LSP_TIMEOUT_MS);
});

describe("parseCljKondoJson", () => {
  test("converts findings into Diagnostic entries", () => {
    const stdout = JSON.stringify({
      findings: [
        {
          filename: "/repo/src/foo.clj",
          type: "unused-binding",
          level: "warning",
          row: 5,
          col: 10,
          message: "unused binding x",
        },
      ],
    });
    const diags = parseCljKondoJson(stdout, "/repo");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      file_id: "file:src/foo.clj",
      position: { line: 5, column: 10 },
      severity: "warning",
      tool: "clj-kondo",
    });
    expect(diags[0]!.message).toContain("unused");
  });
  test("returns empty array on malformed JSON", () => {
    expect(parseCljKondoJson("not json", "/repo")).toEqual([]);
  });
});

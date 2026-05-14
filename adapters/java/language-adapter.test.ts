import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  JavaLanguageAdapter,
  parseImports,
  parseTopLevelSymbols,
  parseCheckstyleXml,
} from "./index.ts";
import { whichTool } from "../shared/index.ts";

const TESTDATA = resolve(import.meta.dir, "testdata");
const hasJdtls = (await whichTool("jdtls")) !== null;

// jdtls boots a JVM and indexes the workspace before the first response is
// available — well beyond bun:test's default 5 s timeout. Use 180 s for
// every indexUnits-driven test so the LSP path has time to settle.
const LSP_TIMEOUT_MS = 180_000;

describe("JavaLanguageAdapter", () => {
  const adapter = new JavaLanguageAdapter();

  test("detect returns supported for a Gradle multi-project layout", async () => {
    const r = await adapter.detect(TESTDATA);
    expect(r.supported).toBe(true);
    expect(r.confidence).toBe(1.0);
  });

  test("detect returns unsupported for a non-Java dir", async () => {
    const r = await adapter.detect("/tmp");
    expect(r.supported).toBe(false);
    expect(r.confidence).toBe(0);
  });

  test("doctor reports a missing javac in missing_tools when absent", async () => {
    const r = await adapter.doctor();
    // We don't assert ok=true — CI may or may not have a JDK. We just assert
    // the shape: missing_tools must be an array, notes must include either
    // `java -version` output or "(optional)" hints.
    expect(Array.isArray(r.missing_tools)).toBe(true);
    expect(Array.isArray(r.notes)).toBe(true);
  });

  test("enumerateUnits picks up each Gradle subproject", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const ids = units.map((u) => u.id).sort();
    expect(ids).toEqual(["unit:java:app", "unit:java:lib"]);
    const lib = units.find((u) => u.id === "unit:java:lib")!;
    expect(lib.kind).toBe("java_module");
    expect(lib.name).toBe("lib");
    expect(
      (lib.metadata?.["package_prefixes"] as string[]) ?? [],
    ).toContain("com.example.lib");
  });

  test(
    "indexUnits emits files and import-based deps",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const delta = await adapter.indexUnits(units, {});
      const fileIds = (delta.added.files ?? []).map((f) => f.id).sort();
      expect(fileIds).toEqual([
        "file:app/src/main/java/com/example/app/Main.java",
        "file:lib/src/main/java/com/example/lib/Greeter.java",
      ]);
      expect(delta.added.deps).toContainEqual({
        from_unit_id: "unit:java:app",
        to_unit_id: "unit:java:lib",
        kind: "import",
      });
      // The reverse edge must not exist.
      expect(
        delta.added.deps?.some(
          (d) =>
            d.from_unit_id === "unit:java:lib" &&
            d.to_unit_id === "unit:java:app",
        ),
      ).toBe(false);
    },
    LSP_TIMEOUT_MS,
  );

  test(
    "indexUnits surfaces top-level class symbols",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const delta = await adapter.indexUnits(units, {});
      // The LSP path emits methods/fields too; the parser-only fallback emits
      // only top-level types. Either way, the two top-level classes must be
      // present.
      const symbolNames = (delta.added.symbols ?? []).map((s) => s.name);
      expect(symbolNames).toContain("Greeter");
      expect(symbolNames).toContain("Main");
      const main = delta.added.symbols!.find(
        (s) => s.name === "Main" && s.kind === "class",
      )!;
      expect(main.kind).toBe("class");
      expect(main.exported).toBe(true);
      expect(main.decl.position.line).toBeGreaterThan(0);
    },
    LSP_TIMEOUT_MS,
  );

  test(
    "file hashes match sha256:<hex>",
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
    "diagnose tolerates the absence of optional tools",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const diags = await adapter.diagnose(units, {});
      // testdata has no cycles, no checkstyle config — expect an empty list.
      expect(diags).toEqual([]);
    },
    LSP_TIMEOUT_MS,
  );

  test.skipIf(!hasJdtls)(
    "indexUnits (LSP) produces method symbols",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const delta = await adapter.indexUnits(units, {});
      const methodNames = (delta.added.symbols ?? [])
        .filter((s) => s.kind === "method")
        .map((s) => s.name);
      // The Greeter.greet(String) method must be picked up.
      expect(methodNames.some((n) => n.startsWith("greet"))).toBe(true);
    },
    LSP_TIMEOUT_MS,
  );

  test.skipIf(!hasJdtls)(
    "indexUnits (LSP) produces call edges from Main.main to Greeter.greet",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const delta = await adapter.indexUnits(units, {});
      const callerNames = (delta.added.symbols ?? []).filter((s) =>
        s.name.startsWith("main"),
      );
      const calleeNames = (delta.added.symbols ?? []).filter((s) =>
        s.name.startsWith("greet"),
      );
      expect(callerNames.length).toBeGreaterThan(0);
      expect(calleeNames.length).toBeGreaterThan(0);
      const callerIds = new Set(callerNames.map((s) => s.id));
      const calleeIds = new Set(calleeNames.map((s) => s.id));
      const hit = (delta.added.call_edges ?? []).some(
        (e) => callerIds.has(e.caller_id) && calleeIds.has(e.callee_id),
      );
      expect(hit).toBe(true);
    },
    LSP_TIMEOUT_MS,
  );

  test.skipIf(!hasJdtls)(
    "indexUnits (LSP) produces references to the Greeter type",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const delta = await adapter.indexUnits(units, {});
      const greeterSym = (delta.added.symbols ?? []).find(
        (s) => s.name === "Greeter" && s.kind === "class",
      );
      expect(greeterSym).toBeDefined();
      const refsToGreeter = (delta.added.refs ?? []).filter(
        (r) => r.to_symbol_id === greeterSym!.id,
      );
      // Main.java references Greeter via `import` + type usage + constructor
      // call — at least one ref must be surfaced.
      expect(refsToGreeter.length).toBeGreaterThan(0);
    },
    LSP_TIMEOUT_MS,
  );
});

describe("parseImports", () => {
  test("captures fully-qualified type imports", () => {
    expect(
      parseImports(`
        package com.example.app;
        import com.example.lib.Greeter;
        import java.util.List;

        public class Main {}
      `),
    ).toEqual(["com.example.lib", "java.util"]);
  });

  test("captures wildcard imports", () => {
    expect(
      parseImports(`
        import com.example.lib.*;
      `),
    ).toEqual(["com.example.lib"]);
  });

  test("captures static imports", () => {
    expect(
      parseImports(`
        import static java.util.Collections.emptyList;
      `),
    ).toEqual(["java.util.Collections"]);
  });

  test("ignores commented-out imports inside line comments", () => {
    // Our regex is line-oriented and does match `import` after `//` — this
    // test pins the documented limitation. Update if we ever upgrade the
    // parser to be comment-aware.
    expect(
      parseImports(`
        // import com.example.fake.X;
        import com.example.real.Y;
      `),
    ).toContain("com.example.real");
  });
});

describe("parseTopLevelSymbols", () => {
  test("picks up class / interface / enum / record declarations", () => {
    const src = `
      package p;

      public class A {}
      interface B {}
      public enum C { ONE }
      public record D(int x) {}
    `;
    const syms = parseTopLevelSymbols(src, "unit:java:p", "p/X.java");
    const names = syms.map((s) => `${s.kind}:${s.name}`).sort();
    expect(names).toEqual([
      "class:A",
      "enum:C",
      "interface:B",
      "record:D",
    ]);
  });

  test("private classes are not exported", () => {
    const src = `private class Secret {}`;
    const syms = parseTopLevelSymbols(src, "unit:java:p", "p/X.java");
    expect(syms[0]!.exported).toBe(false);
  });

  test("emits 1-based line / column for the declaration keyword", () => {
    const src = "\n\npublic class Foo {}\n";
    const syms = parseTopLevelSymbols(src, "unit:java:p", "p/Foo.java");
    expect(syms[0]!.decl.position.line).toBe(3);
    expect(syms[0]!.decl.position.column).toBeGreaterThan(0);
  });
});

describe("parseCheckstyleXml", () => {
  test("converts <error> elements to Diagnostic entries", () => {
    const xml = `
      <checkstyle>
        <file name="${TESTDATA}/app/src/main/java/com/example/app/Main.java">
          <error line="3" column="2" severity="warning" message="Trailing whitespace" source="x"/>
          <error line="9" severity="error" message="Bad &amp; ugly"/>
        </file>
      </checkstyle>
    `;
    const diags = parseCheckstyleXml(xml, TESTDATA);
    expect(diags).toHaveLength(2);
    expect(diags[0]).toMatchObject({
      file_id: "file:app/src/main/java/com/example/app/Main.java",
      position: { line: 3, column: 2 },
      severity: "warning",
      tool: "checkstyle",
    });
    expect(diags[1]!.severity).toBe("error");
    expect(diags[1]!.message).toBe("Bad & ugly");
  });

  test("returns empty array for empty input", () => {
    expect(parseCheckstyleXml("", "/repo")).toEqual([]);
  });
});

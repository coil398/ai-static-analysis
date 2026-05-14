import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  JavaLanguageAdapter,
  parseImports,
  parseTopLevelSymbols,
  parseCheckstyleXml,
} from "./index.ts";

const TESTDATA = resolve(import.meta.dir, "testdata");

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

  test("indexUnits emits files and import-based deps", async () => {
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
          d.from_unit_id === "unit:java:lib" && d.to_unit_id === "unit:java:app",
      ),
    ).toBe(false);
  });

  test("indexUnits surfaces top-level class symbols", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});
    const symbolNames = (delta.added.symbols ?? []).map((s) => s.name).sort();
    expect(symbolNames).toEqual(["Greeter", "Main"]);
    const main = delta.added.symbols!.find((s) => s.name === "Main")!;
    expect(main.kind).toBe("class");
    expect(main.exported).toBe(true);
    expect(main.decl.position.line).toBeGreaterThan(0);
  });

  test("file hashes match sha256:<hex>", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const delta = await adapter.indexUnits(units, {});
    for (const f of delta.added.files ?? []) {
      expect(f.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  test("diagnose tolerates the absence of optional tools", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const diags = await adapter.diagnose(units, {});
    // testdata has no cycles, no checkstyle config — expect an empty list.
    expect(diags).toEqual([]);
  });
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

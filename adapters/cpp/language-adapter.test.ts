import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CppLanguageAdapter,
  parseIncludes,
  parseCppcheckOutput,
  parseClangTidyOutput,
} from "./index.ts";
import { whichTool } from "../shared/index.ts";

const TESTDATA = resolve(import.meta.dir, "testdata");
const hasClangd = (await whichTool("clangd")) !== null;
const LSP_TIMEOUT_MS = 180_000;

describe("CppLanguageAdapter", () => {
  const adapter = new CppLanguageAdapter();

  test("detect returns supported for a CMake project", async () => {
    const r = await adapter.detect(TESTDATA);
    expect(r.supported).toBe(true);
    expect(r.confidence).toBe(1.0);
  });

  test("detect returns unsupported for an empty dir", async () => {
    const empty = await mkdtemp(join(tmpdir(), "cpp-detect-"));
    try {
      const r = await adapter.detect(empty);
      expect(r.supported).toBe(false);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("doctor reports a missing compiler when absent", async () => {
    const r = await adapter.doctor();
    expect(Array.isArray(r.missing_tools)).toBe(true);
    expect(Array.isArray(r.notes)).toBe(true);
  });

  test("enumerateUnits picks each top-level source dir", async () => {
    const units = await adapter.enumerateUnits(TESTDATA, {});
    const ids = units.map((u) => u.id).sort();
    expect(ids).toEqual(["unit:cpp:app", "unit:cpp:lib"]);
    const lib = units.find((u) => u.id === "unit:cpp:lib")!;
    expect(lib.kind).toBe("cpp_module");
    expect(lib.name).toBe("lib");
  });

  test(
    "indexUnits emits files, includes/headers, and #include-based deps",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const delta = await adapter.indexUnits(units, {});
      const fileIds = (delta.added.files ?? []).map((f) => f.id).sort();
      expect(fileIds).toContain("file:lib/greet.cpp");
      expect(fileIds).toContain("file:app/main.cpp");
      // include/greet.hpp is loose-header — must be indexed too.
      expect(fileIds).toContain("file:include/greet.hpp");
      // app uses #include "greet.hpp"; the header is attributed to the first
      // unit (lib here, since topLevelSourceDirs returns alphabetically).
      // Either app → lib or app → loose-header-owner is acceptable; just
      // assert app does NOT depend on itself and there's at least one dep.
      const appDeps = (delta.added.deps ?? []).filter(
        (d) => d.from_unit_id === "unit:cpp:app",
      );
      expect(appDeps.length).toBeGreaterThan(0);
      expect(
        appDeps.some((d) => d.from_unit_id === d.to_unit_id),
      ).toBe(false);
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
    "diagnose tolerates missing optional tools",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const diags = await adapter.diagnose(units, {});
      // No cycles in testdata. If cppcheck is installed it may flag
      // something — accept any output shape.
      expect(Array.isArray(diags)).toBe(true);
    },
    LSP_TIMEOUT_MS,
  );

  test.skipIf(!hasClangd)(
    "indexUnits (LSP) produces class/method symbols",
    async () => {
      const units = await adapter.enumerateUnits(TESTDATA, {});
      const delta = await adapter.indexUnits(units, {});
      const names = (delta.added.symbols ?? []).map((s) => s.name);
      expect(names.some((n) => n === "Greeter")).toBe(true);
      // clangd often emits the method name with parentheses; accept either.
      expect(names.some((n) => n.startsWith("greet"))).toBe(true);
    },
    LSP_TIMEOUT_MS,
  );
});

describe("parseIncludes", () => {
  test('captures quoted local includes only — angle brackets are ignored', () => {
    expect(
      parseIncludes(`
        #include <iostream>
        #include "greet.hpp"
        #include  "util/log.hpp"
      `),
    ).toEqual(["greet.hpp", "util/log.hpp"]);
  });

  test("returns empty array when no includes are present", () => {
    expect(parseIncludes("int main() { return 0; }")).toEqual([]);
  });
});

describe("parseClangTidyOutput", () => {
  test("parses warning and error lines into Diagnostic entries", () => {
    const cwd = "/repo";
    const out = parseClangTidyOutput(
      `/repo/foo.cpp:5:10: warning: use nullptr instead of 0 [modernize-use-nullptr]\n` +
      `/repo/bar.cpp:3:1: error: null pointer dereference [clang-analyzer-core.NullDereference]\n`,
      cwd,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      file_id: "file:foo.cpp",
      position: { line: 5, column: 10 },
      severity: "warning",
      tool: "clang-tidy",
    });
    expect(out[0]!.message).toContain("modernize-use-nullptr");
    expect(out[1]).toMatchObject({
      file_id: "file:bar.cpp",
      position: { line: 3, column: 1 },
      severity: "error",
      tool: "clang-tidy",
    });
  });

  test("excludes note lines", () => {
    const out = parseClangTidyOutput(
      `/repo/foo.cpp:5:10: note: 'x' declared here\n` +
      `/repo/foo.cpp:7:3: warning: unused variable [clang-diagnostic-unused-variable]\n`,
      "/repo",
    );
    // note lines are excluded; only the warning remains
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("warning");
  });

  test("excludes files outside repoRoot", () => {
    const out = parseClangTidyOutput(
      `/outside/foo.cpp:1:1: warning: something [check]\n`,
      "/repo",
    );
    expect(out).toHaveLength(0);
  });

  test("returns empty array for empty input", () => {
    expect(parseClangTidyOutput("", "/repo")).toEqual([]);
  });
});

describe("parseCppcheckOutput", () => {
  test("parses warnings into Diagnostic entries", () => {
    const cwd = "/repo";
    const out = parseCppcheckOutput(
      `/repo/foo.cpp:10:5: warning: variable 'x' shadows outer one [shadowVar]\n` +
        `/repo/bar.cpp:1:1: error: Bad thing happened [badThing]\n`,
      cwd,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      file_id: "file:foo.cpp",
      position: { line: 10, column: 5 },
      severity: "warning",
      tool: "cppcheck",
    });
    expect(out[0]!.message).toContain("shadowVar");
    expect(out[1]!.severity).toBe("error");
  });
});

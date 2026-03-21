import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import {
  parseSymbolsOutput,
  parseCallHierarchyOutput,
  parseImplementationOutput,
  parseReferencesOutput,
  goplsSymbols,
  goplsCallHierarchy,
  goplsImplementation,
} from "./gopls.ts";

const TESTDATA = resolve(import.meta.dir, "testdata");

// --- Parser unit tests ---

describe("parseSymbolsOutput", () => {
  test("parses top-level and nested symbols", () => {
    const output = `Service Struct 6:6-6:13
\tstore Field 7:2-7:7
NewService Function 11:6-11:16
(*Service).Hello Method 16:19-16:24`;

    const symbols = parseSymbolsOutput(output);
    expect(symbols).toHaveLength(3);

    expect(symbols[0]!.name).toBe("Service");
    expect(symbols[0]!.kind).toBe("Struct");
    expect(symbols[0]!.line).toBe(6);
    expect(symbols[0]!.children).toHaveLength(1);
    expect(symbols[0]!.children[0]!.name).toBe("store");
    expect(symbols[0]!.children[0]!.kind).toBe("Field");
    expect(symbols[0]!.children[0]!.parentName).toBe("Service");

    expect(symbols[1]!.name).toBe("NewService");
    expect(symbols[1]!.kind).toBe("Function");

    expect(symbols[2]!.name).toBe("(*Service).Hello");
    expect(symbols[2]!.kind).toBe("Method");
  });

  test("handles empty output", () => {
    expect(parseSymbolsOutput("")).toEqual([]);
  });
});

describe("parseCallHierarchyOutput", () => {
  test("parses identifier and callees", () => {
    const output = `identifier: function main in /repo/main.go:9:6-10
callee[0]: ranges 10:11-21 in /repo/main.go from/to function NewService in /repo/pkg/service.go:11:6-16
callee[1]: ranges 11:6-13 in /repo/main.go from/to function Println in /usr/local/go/src/fmt/print.go:313:6-13`;

    const result = parseCallHierarchyOutput(output);

    expect(result.identifier.name).toBe("main");
    expect(result.identifier.file).toBe("/repo/main.go");
    expect(result.identifier.line).toBe(9);

    expect(result.outgoing).toHaveLength(2);
    expect(result.outgoing[0]!.name).toBe("NewService");
    expect(result.outgoing[0]!.rangeLine).toBe(10);
    expect(result.outgoing[0]!.rangeCol).toBe(11);
    expect(result.outgoing[1]!.name).toBe("Println");

    expect(result.incoming).toHaveLength(0);
  });

  test("parses incoming calls", () => {
    const output = `incoming[0]: function main in /repo/main.go:9:6-10
identifier: function NewService in /repo/pkg/service.go:11:6-16
callee[0]: ranges 12:28-36 in /repo/pkg/service.go from/to function NewStore in /repo/db/db.go:7:6-14`;

    const result = parseCallHierarchyOutput(output);

    expect(result.incoming).toHaveLength(1);
    expect(result.incoming[0]!.name).toBe("main");
    expect(result.identifier.name).toBe("NewService");
    expect(result.outgoing).toHaveLength(1);
    expect(result.outgoing[0]!.name).toBe("NewStore");
  });
});

describe("parseImplementationOutput", () => {
  test("parses location lines", () => {
    const output = `/repo/internal/db/db.go:9:6-11
/repo/other/store.go:15:6-20`;

    const locs = parseImplementationOutput(output);
    expect(locs).toHaveLength(2);
    expect(locs[0]).toEqual({ file: "/repo/internal/db/db.go", line: 9, col: 6, endCol: 11 });
    expect(locs[1]).toEqual({ file: "/repo/other/store.go", line: 15, col: 6, endCol: 20 });
  });

  test("handles empty output", () => {
    expect(parseImplementationOutput("")).toEqual([]);
  });
});

describe("parseReferencesOutput", () => {
  test("parses location lines (same format as implementation)", () => {
    const output = `/repo/pkg/service.go:11:6-16`;
    const locs = parseReferencesOutput(output);
    expect(locs).toHaveLength(1);
    expect(locs[0]!.file).toBe("/repo/pkg/service.go");
  });
});

// --- Integration tests (require gopls) ---

describe("gopls integration", () => {
  test("goplsSymbols returns symbols for a file", async () => {
    const symbols = await goplsSymbols("pkg/service.go", TESTDATA);
    const names = symbols.map((s) => s.name);
    expect(names).toContain("Service");
    expect(names).toContain("NewService");
    expect(names).toContain("(*Service).Hello");

    // Service should have children (store field)
    const service = symbols.find((s) => s.name === "Service");
    expect(service!.children.length).toBeGreaterThan(0);
  });

  test("goplsCallHierarchy returns call edges from main", async () => {
    const result = await goplsCallHierarchy("main.go", 9, 6, TESTDATA);
    expect(result).not.toBeNull();
    expect(result!.identifier.name).toBe("main");
    expect(result!.outgoing.length).toBeGreaterThan(0);

    const calleeNames = result!.outgoing.map((c) => c.name);
    expect(calleeNames).toContain("NewService");
    expect(calleeNames).toContain("Hello");
  });

  test("goplsImplementation finds implementors of Storer", async () => {
    const locs = await goplsImplementation(
      "internal/db/db.go",
      4,
      6,
      TESTDATA,
    );
    expect(locs.length).toBeGreaterThan(0);
    // Store implements Storer
    expect(locs.some((l) => l.file.includes("db.go"))).toBe(true);
  });
});

import { describe, test, expect } from "bun:test";
import { diagnosticsToSarif } from "./sarif.ts";
import type { Diagnostic } from "../schema/types.ts";

const baseDiag = (overrides: Partial<Diagnostic> = {}): Diagnostic => ({
  file_id: "file:src/foo.go",
  position: { line: 7, column: 3 },
  severity: "warning",
  message: "unused variable",
  tool: "staticcheck",
  ...overrides,
});

describe("diagnosticsToSarif", () => {
  test("emits an empty log when there are no diagnostics", () => {
    const log = diagnosticsToSarif([]);
    expect(log.version).toBe("2.1.0");
    expect(log.runs).toEqual([]);
  });

  test("groups diagnostics by tool into one run per tool", () => {
    const log = diagnosticsToSarif([
      baseDiag({ tool: "staticcheck" }),
      baseDiag({ tool: "staticcheck", position: { line: 12, column: 1 } }),
      baseDiag({ tool: "gopls/stringsbuilder", severity: "hint" }),
    ]);
    expect(log.runs).toHaveLength(2);
    const drivers = log.runs.map((r) => r.tool.driver.name).sort();
    expect(drivers).toEqual(["gopls/stringsbuilder", "staticcheck"]);
    const staticcheckRun = log.runs.find((r) => r.tool.driver.name === "staticcheck")!;
    expect(staticcheckRun.results).toHaveLength(2);
  });

  test("maps severities to SARIF levels (hint and info become note)", () => {
    const log = diagnosticsToSarif([
      baseDiag({ severity: "error", tool: "t-err" }),
      baseDiag({ severity: "warning", tool: "t-warn" }),
      baseDiag({ severity: "info", tool: "t-info" }),
      baseDiag({ severity: "hint", tool: "t-hint" }),
    ]);
    const levelOf = (name: string) =>
      log.runs.find((r) => r.tool.driver.name === name)!.results[0]!.level;
    expect(levelOf("t-err")).toBe("error");
    expect(levelOf("t-warn")).toBe("warning");
    expect(levelOf("t-info")).toBe("note");
    expect(levelOf("t-hint")).toBe("note");
  });

  test("strips the synthetic file: prefix from artifact URIs", () => {
    const log = diagnosticsToSarif([baseDiag({ file_id: "file:pkg/a.go" })]);
    const loc = log.runs[0]!.results[0]!.locations[0]!;
    expect(loc.physicalLocation.artifactLocation.uri).toBe("pkg/a.go");
  });

  test("preserves line/column under physicalLocation.region", () => {
    const log = diagnosticsToSarif([
      baseDiag({ position: { line: 42, column: 9 } }),
    ]);
    const region = log.runs[0]!.results[0]!.locations[0]!.physicalLocation.region;
    expect(region.startLine).toBe(42);
    expect(region.startColumn).toBe(9);
  });

  test("derives a stable ruleId from a trailing bracketed code", () => {
    const log = diagnosticsToSarif([
      baseDiag({
        tool: "staticcheck",
        message: "should use ... [SA1019]",
      }),
    ]);
    const result = log.runs[0]!.results[0]!;
    expect(result.ruleId).toBe("staticcheck/SA1019");
    // The rule descriptor must also be registered on the driver.
    const ids = log.runs[0]!.tool.driver.rules.map((r) => r.id);
    expect(ids).toContain("staticcheck/SA1019");
  });

  test("falls back to the tool name when no code is present", () => {
    const log = diagnosticsToSarif([
      baseDiag({ tool: "pyright", message: "no trailing code here" }),
    ]);
    expect(log.runs[0]!.results[0]!.ruleId).toBe("pyright");
  });

  test("de-duplicates ruleId entries in driver.rules", () => {
    const log = diagnosticsToSarif([
      baseDiag({ tool: "t", message: "msg one [X]" }),
      baseDiag({ tool: "t", message: "msg two [X]" }),
      baseDiag({ tool: "t", message: "no code" }),
    ]);
    const ids = log.runs[0]!.tool.driver.rules.map((r) => r.id).sort();
    expect(ids).toEqual(["t", "t/X"]);
  });

  test("includes the SARIF v2.1.0 $schema URL", () => {
    const log = diagnosticsToSarif([]);
    expect(log.$schema).toMatch(/sarif-schema-2\.1\.0\.json$/);
  });

  test("threads informationUri to the driver when provided", () => {
    const log = diagnosticsToSarif([baseDiag()], {
      informationUri: "https://example.com/tool",
    });
    expect(log.runs[0]!.tool.driver.informationUri).toBe(
      "https://example.com/tool",
    );
  });
});

// SARIF v2.1.0 export — convert internal Diagnostic[] to a SARIF log.
// Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html
//
// One SARIF run is emitted per distinct `tool` (e.g. "gopls/stringsbuilder",
// "staticcheck", "pyright"). GitHub code scanning ingests the resulting log
// directly via the upload-sarif action.

import type { Diagnostic } from "../schema/types.ts";

export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: SarifRun[];
}

export interface SarifRun {
  tool: { driver: SarifDriver };
  results: SarifResult[];
}

export interface SarifDriver {
  name: string;
  informationUri?: string;
  rules: SarifReportingDescriptor[];
}

export interface SarifReportingDescriptor {
  id: string;
  name?: string;
  shortDescription?: { text: string };
}

export interface SarifResult {
  ruleId: string;
  level: "none" | "note" | "warning" | "error";
  message: { text: string };
  locations: SarifLocation[];
}

export interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region: { startLine: number; startColumn?: number };
  };
}

const SARIF_SCHEMA_URI =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";

/** Internal severity → SARIF level. */
function severityToLevel(s: Diagnostic["severity"]): SarifResult["level"] {
  switch (s) {
    case "error": return "error";
    case "warning": return "warning";
    case "info": return "note";
    case "hint": return "note";
  }
}

/**
 * `file:foo/bar.go` → `foo/bar.go`. SARIF requires repo-relative URIs without
 * the synthetic `file:` prefix used inside facts.
 */
function fileIdToUri(fileId: string): string {
  return fileId.startsWith("file:") ? fileId.slice(5) : fileId;
}

/**
 * Derive a stable ruleId from a Diagnostic. Diagnostics don't carry a rule id
 * directly, so we fall back to the message-leading bracketed `[code]` token
 * emitted by gopls integration (e.g. "... [SA1019]"), and otherwise hash the
 * tool+message tail into a short slug. This keeps the per-rule grouping stable
 * across runs even when tools don't expose explicit codes.
 */
function deriveRuleId(d: Diagnostic): string {
  const m = /\[([^\]]+)\]\s*$/.exec(d.message);
  if (m) return `${d.tool}/${m[1]}`;
  return d.tool;
}

/** Convert internal diagnostics to a SARIF v2.1.0 log. */
export function diagnosticsToSarif(
  diagnostics: Diagnostic[],
  options?: { informationUri?: string },
): SarifLog {
  const byTool = new Map<string, Diagnostic[]>();
  for (const d of diagnostics) {
    const bucket = byTool.get(d.tool);
    if (bucket) bucket.push(d);
    else byTool.set(d.tool, [d]);
  }

  const runs: SarifRun[] = [];
  for (const [tool, items] of byTool) {
    const ruleIds = new Map<string, SarifReportingDescriptor>();
    const results: SarifResult[] = [];
    for (const d of items) {
      const ruleId = deriveRuleId(d);
      if (!ruleIds.has(ruleId)) {
        ruleIds.set(ruleId, { id: ruleId, name: ruleId });
      }
      results.push({
        ruleId,
        level: severityToLevel(d.severity),
        message: { text: d.message },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: fileIdToUri(d.file_id) },
              region: {
                startLine: d.position.line,
                startColumn: d.position.column,
              },
            },
          },
        ],
      });
    }
    runs.push({
      tool: {
        driver: {
          name: tool,
          informationUri: options?.informationUri,
          rules: [...ruleIds.values()],
        },
      },
      results,
    });
  }

  return { $schema: SARIF_SCHEMA_URI, version: "2.1.0", runs };
}

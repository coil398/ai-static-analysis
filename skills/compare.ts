// compare-facts skill — diff two facts snapshots and surface what changed.
//
// Typical usage: index the codebase at two commits / branches into separate
// cache directories, then run `compareFacts` to enumerate added / removed
// units, files, symbols, diagnostics — and (optionally) the units transitively
// impacted by file-level changes.

import { join } from "node:path";
import type {
  Facts,
  Unit,
  File,
  Dep,
  Symbol,
  Diagnostic,
} from "../core/schema/types.ts";
import { readFactsPartial } from "../core/storage/index.ts";
import type { FactsField } from "../core/storage/index.ts";
import { impactUnits } from "../core/diff/index.ts";

export interface CompareOptions {
  /** "before" snapshot cacheDir (e.g. main branch). */
  baseCacheDir: string;
  /** "after" snapshot cacheDir (e.g. feature branch). */
  headCacheDir: string;
  /**
   * If true, also compute the set of units impacted by the file-level
   * changes (using head's deps graph). Off by default — opt in when needed.
   */
  includeImpact?: boolean;
}

export interface DiagnosticChange {
  before: Diagnostic;
  after: Diagnostic;
}

export interface CompareResult {
  units: { added: Unit[]; removed: Unit[] };
  files: { added: File[]; removed: File[]; modified: File[] };
  deps: { added: Dep[]; removed: Dep[] };
  symbols: { added: Symbol[]; removed: Symbol[] };
  diagnostics: {
    added: Diagnostic[];
    removed: Diagnostic[];
    /** Same (file, line, tool) key but different severity or message. */
    changed: DiagnosticChange[];
  };
  /** Populated only when options.includeImpact is true. */
  impact?: { affectedUnits: string[] };
}

const COMPARE_FIELDS: FactsField[] = [
  "units",
  "files",
  "deps",
  "symbols",
  "diagnostics",
];

async function loadFactsForCompare(cacheDir: string): Promise<Facts> {
  const facts = await readFactsPartial(cacheDir, COMPARE_FIELDS);
  if (!facts) {
    throw new Error(
      `No cached facts found at ${cacheDir}. Run index-facts there first.`,
    );
  }
  return facts;
}

/** Composite key for a diagnostic — what we treat as "the same finding". */
function diagnosticKey(d: Diagnostic): string {
  return `${d.tool}::${d.file_id}::${d.position.line}:${d.position.column}`;
}

function indexBy<T>(items: T[], key: (t: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of items) out.set(key(item), item);
  return out;
}

export async function compareFacts(
  opts: CompareOptions,
): Promise<CompareResult> {
  const [base, head] = await Promise.all([
    loadFactsForCompare(opts.baseCacheDir),
    loadFactsForCompare(opts.headCacheDir),
  ]);

  // Units — keyed by id.
  const baseUnits = indexBy(base.units, (u) => u.id);
  const headUnits = indexBy(head.units, (u) => u.id);
  const addedUnits = head.units.filter((u) => !baseUnits.has(u.id));
  const removedUnits = base.units.filter((u) => !headUnits.has(u.id));

  // Files — keyed by id (path-based); modified when hash differs.
  const baseFiles = indexBy(base.files, (f) => f.id);
  const headFiles = indexBy(head.files, (f) => f.id);
  const addedFiles = head.files.filter((f) => !baseFiles.has(f.id));
  const removedFiles = base.files.filter((f) => !headFiles.has(f.id));
  const modifiedFiles = head.files.filter((f) => {
    const before = baseFiles.get(f.id);
    return before !== undefined && before.hash !== f.hash;
  });

  // Deps — composite (from, to, kind).
  const depKey = (d: Dep) => `${d.from_unit_id}::${d.to_unit_id}::${d.kind}`;
  const baseDeps = indexBy(base.deps, depKey);
  const headDeps = indexBy(head.deps, depKey);
  const addedDeps = head.deps.filter((d) => !baseDeps.has(depKey(d)));
  const removedDeps = base.deps.filter((d) => !headDeps.has(depKey(d)));

  // Symbols — keyed by id (which already encodes unit + name + signature).
  const baseSymbols = indexBy(base.symbols, (s) => s.id);
  const headSymbols = indexBy(head.symbols, (s) => s.id);
  const addedSymbols = head.symbols.filter((s) => !baseSymbols.has(s.id));
  const removedSymbols = base.symbols.filter((s) => !headSymbols.has(s.id));

  // Diagnostics — added/removed/changed by location+tool.
  const baseDiagMap = indexBy(base.diagnostics, diagnosticKey);
  const headDiagMap = indexBy(head.diagnostics, diagnosticKey);
  const addedDiags: Diagnostic[] = [];
  const removedDiags: Diagnostic[] = [];
  const changedDiags: DiagnosticChange[] = [];
  for (const d of head.diagnostics) {
    const before = baseDiagMap.get(diagnosticKey(d));
    if (!before) addedDiags.push(d);
    else if (before.message !== d.message || before.severity !== d.severity) {
      changedDiags.push({ before, after: d });
    }
  }
  for (const d of base.diagnostics) {
    if (!headDiagMap.has(diagnosticKey(d))) removedDiags.push(d);
  }

  const result: CompareResult = {
    units: { added: addedUnits, removed: removedUnits },
    files: { added: addedFiles, removed: removedFiles, modified: modifiedFiles },
    deps: { added: addedDeps, removed: removedDeps },
    symbols: { added: addedSymbols, removed: removedSymbols },
    diagnostics: {
      added: addedDiags,
      removed: removedDiags,
      changed: changedDiags,
    },
  };

  if (opts.includeImpact) {
    // Use file-path changes (added + removed + modified) as the change set,
    // then expand via deps using head's snapshot. Mirrors `queryImpact`'s
    // direct phase; full transitive expansion lives in skills/query.
    const changedPaths = [
      ...addedFiles.map((f) => f.path),
      ...removedFiles.map((f) => f.path),
      ...modifiedFiles.map((f) => f.path),
    ];
    const direct = impactUnits(changedPaths, head);
    const affected = new Set(direct);
    const rdepMap = new Map<string, string[]>();
    for (const dep of head.deps) {
      const list = rdepMap.get(dep.to_unit_id);
      if (list) list.push(dep.from_unit_id);
      else rdepMap.set(dep.to_unit_id, [dep.from_unit_id]);
    }
    const queue = [...direct];
    while (queue.length > 0) {
      const u = queue.shift()!;
      for (const from of rdepMap.get(u) ?? []) {
        if (!affected.has(from)) {
          affected.add(from);
          queue.push(from);
        }
      }
    }
    result.impact = { affectedUnits: [...affected] };
  }

  return result;
}

/**
 * Compact text summary suitable for PR comments or CLI output.
 * One line per category, with sample names truncated.
 */
export function summarizeCompare(result: CompareResult): string {
  const parts: string[] = [];
  const fmt = (label: string, added: number, removed: number) =>
    `${label}: +${added} / -${removed}`;
  parts.push(fmt("units", result.units.added.length, result.units.removed.length));
  parts.push(
    `files: +${result.files.added.length} / -${result.files.removed.length} (modified ${result.files.modified.length})`,
  );
  parts.push(fmt("deps", result.deps.added.length, result.deps.removed.length));
  parts.push(
    fmt("symbols", result.symbols.added.length, result.symbols.removed.length),
  );
  parts.push(
    `diagnostics: +${result.diagnostics.added.length} / -${result.diagnostics.removed.length} (changed ${result.diagnostics.changed.length})`,
  );
  if (result.impact) {
    parts.push(`impact: ${result.impact.affectedUnits.length} units`);
  }
  return parts.join("\n");
}

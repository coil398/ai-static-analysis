// query-facts skill — query engine over cached facts

import { join } from "node:path";
import type {
  Facts,
  Unit,
  Dep,
  Symbol,
  Ref,
  Diagnostic,
  TypeRelation,
  CallEdge,
} from "../core/schema/types.ts";
import { readFacts } from "../core/storage/index.ts";
import { impactUnits } from "../core/diff/index.ts";

export interface QueryOptions {
  repoRoot: string;
  cacheDir?: string;
}

// --- Result types ---

export interface DepsResult {
  unitId: string;
  deps: Dep[];
}

export interface RdepsResult {
  unitId: string;
  rdeps: Dep[];
}

export interface DefsResult {
  symbols: Symbol[];
}

export interface RefsResult {
  symbolId: string;
  refs: Ref[];
}

export interface DiagnosticsResult {
  diagnostics: Diagnostic[];
}

export interface ImpactResult {
  changedFiles: string[];
  affectedUnits: string[];
  affectedDeps: Dep[];
}

export interface ImplsResult {
  typeId: string;
  implementations: TypeRelation[];
}

export interface CallersResult {
  symbolId: string;
  callers: CallEdge[];
}

export interface CalleesResult {
  symbolId: string;
  callees: CallEdge[];
}

// --- Internal helper ---

async function loadFacts(opts: QueryOptions): Promise<Facts> {
  const cacheDir = opts.cacheDir ?? join(opts.repoRoot, "cache");
  const facts = await readFacts(cacheDir);
  if (!facts) {
    throw new Error(
      `No cached facts found. Run index-facts first. (cacheDir: ${cacheDir})`,
    );
  }
  return facts;
}

// --- Query functions ---

export async function queryDeps(
  unitId: string,
  opts: QueryOptions,
): Promise<DepsResult> {
  const facts = await loadFacts(opts);
  const deps = facts.deps.filter((d) => d.from_unit_id === unitId);
  return { unitId, deps };
}

export async function queryRdeps(
  unitId: string,
  opts: QueryOptions,
): Promise<RdepsResult> {
  const facts = await loadFacts(opts);
  const rdeps = facts.deps.filter((d) => d.to_unit_id === unitId);
  return { unitId, rdeps };
}

export async function queryDefs(
  query: string | { name?: string; path?: string; id?: string },
  opts: QueryOptions,
): Promise<DefsResult> {
  const facts = await loadFacts(opts);

  let symbols: Symbol[];
  if (typeof query === "string") {
    // Simple name search
    symbols = facts.symbols.filter((s) => s.name === query);
  } else {
    symbols = facts.symbols.filter((s) => {
      if (query.id && s.id !== query.id) return false;
      if (query.name && s.name !== query.name) return false;
      if (query.path) {
        // Match against file path in declaration
        const file = facts.files.find((f) => f.id === s.decl.file_id);
        if (!file || !file.path.includes(query.path)) return false;
      }
      return true;
    });
  }

  return { symbols };
}

export async function queryRefs(
  symbolId: string,
  opts: QueryOptions,
): Promise<RefsResult> {
  const facts = await loadFacts(opts);
  const refs = facts.refs.filter((r) => r.to_symbol_id === symbolId);
  return { symbolId, refs };
}

export async function queryDiagnostics(
  scope: "repo" | { unit: string } | { file: string },
  opts: QueryOptions,
): Promise<DiagnosticsResult> {
  const facts = await loadFacts(opts);

  if (scope === "repo") {
    return { diagnostics: facts.diagnostics };
  }

  if ("file" in scope) {
    const fileId = scope.file.startsWith("file:")
      ? scope.file
      : `file:${scope.file}`;
    const diagnostics = facts.diagnostics.filter(
      (d) => d.file_id === fileId,
    );
    return { diagnostics };
  }

  // unit scope — find all files in the unit, then filter diagnostics
  const unitFileIds = new Set(
    facts.files.filter((f) => f.unit_id === scope.unit).map((f) => f.id),
  );
  const diagnostics = facts.diagnostics.filter((d) =>
    unitFileIds.has(d.file_id),
  );
  return { diagnostics };
}

export async function queryImpact(
  changedFiles: string[],
  opts: QueryOptions,
): Promise<ImpactResult> {
  const facts = await loadFacts(opts);
  const affectedUnits = impactUnits(changedFiles, facts);
  const affectedUnitSet = new Set(affectedUnits);

  // Find deps that touch affected units
  const affectedDeps = facts.deps.filter(
    (d) =>
      affectedUnitSet.has(d.from_unit_id) ||
      affectedUnitSet.has(d.to_unit_id),
  );

  return { changedFiles, affectedUnits, affectedDeps };
}

export async function queryImpls(
  typeId: string,
  opts: QueryOptions,
): Promise<ImplsResult> {
  const facts = await loadFacts(opts);
  const implementations = facts.type_relations.filter(
    (r) => r.to_type_id === typeId && r.kind === "implements",
  );
  return { typeId, implementations };
}

export async function queryCallers(
  symbolId: string,
  opts: QueryOptions,
): Promise<CallersResult> {
  const facts = await loadFacts(opts);
  const callers = facts.call_edges.filter((e) => e.callee_id === symbolId);
  return { symbolId, callers };
}

export async function queryCallees(
  symbolId: string,
  opts: QueryOptions,
): Promise<CalleesResult> {
  const facts = await loadFacts(opts);
  const callees = facts.call_edges.filter((e) => e.caller_id === symbolId);
  return { symbolId, callees };
}

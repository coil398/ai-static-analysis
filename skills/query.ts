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
import { readFacts, readFactsPartial } from "../core/storage/index.ts";
import type { FactsField } from "../core/storage/index.ts";
import { impactUnits } from "../core/diff/index.ts";
import {
  loadSymbolByName,
  loadRefsBySymbol,
} from "../core/index/index.ts";

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

export interface DeadCodeResult {
  /** Exported symbols with zero incoming references (excluding main/init) */
  deadSymbols: Array<{
    symbol: Symbol;
    unitId: string;
  }>;
}

// --- Internal helpers ---

function resolveCacheDir(opts: QueryOptions): string {
  return opts.cacheDir ?? join(opts.repoRoot, "cache");
}

// In-process cache with incremental field loading.
// Tracks which fields have been loaded per cacheDir.
interface CacheEntry {
  facts: Facts;
  loadedFields: Set<FactsField>;
  loadedAt: number;
}
const factsCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000; // 30 seconds

/** Clear the in-process facts cache (useful after writes or in tests). */
export function clearFactsCache(): void {
  factsCache.clear();
}

/**
 * Load only the specified fields from facts.
 * Cached fields are reused; missing fields are loaded incrementally.
 */
async function loadFactsFields(
  opts: QueryOptions,
  fields: FactsField[],
): Promise<Facts> {
  const cacheDir = resolveCacheDir(opts);

  // Check cache validity
  const cached = factsCache.get(cacheDir);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    // Determine which fields still need loading
    const missing = fields.filter((f) => !cached.loadedFields.has(f));
    if (missing.length === 0) {
      return cached.facts;
    }
    // Load only missing fields and merge
    const partial = await readFactsPartial(cacheDir, missing);
    if (!partial) {
      throw new Error(
        `No cached facts found. Run index-facts first. (cacheDir: ${cacheDir})`,
      );
    }
    for (const field of missing) {
      (cached.facts[field] as unknown[]) = partial[field];
      cached.loadedFields.add(field);
    }
    return cached.facts;
  }

  // Fresh load
  const facts = await readFactsPartial(cacheDir, fields);
  if (!facts) {
    throw new Error(
      `No cached facts found. Run index-facts first. (cacheDir: ${cacheDir})`,
    );
  }

  factsCache.set(cacheDir, {
    facts,
    loadedFields: new Set(fields),
    loadedAt: Date.now(),
  });
  return facts;
}

/** Load all fields (for queries that need everything or legacy fallback). */
async function loadFacts(opts: QueryOptions): Promise<Facts> {
  return loadFactsFields(opts, [
    "units", "files", "deps", "symbols", "refs",
    "type_relations", "call_edges", "diagnostics",
  ]);
}

// --- Query functions ---

export async function queryDeps(
  unitId: string,
  opts: QueryOptions,
): Promise<DepsResult> {
  const facts = await loadFactsFields(opts, ["deps"]);
  const deps = facts.deps.filter((d) => d.from_unit_id === unitId);
  return { unitId, deps };
}

export async function queryRdeps(
  unitId: string,
  opts: QueryOptions,
): Promise<RdepsResult> {
  const facts = await loadFactsFields(opts, ["deps"]);
  const rdeps = facts.deps.filter((d) => d.to_unit_id === unitId);
  return { unitId, rdeps };
}

export async function queryDefs(
  query: string | { name?: string; path?: string; id?: string },
  opts: QueryOptions,
): Promise<DefsResult> {
  const cacheDir = resolveCacheDir(opts);
  // Need symbols always; files only for path-based queries
  const needFiles = typeof query !== "string" && !!(query as { path?: string }).path;
  const fields: FactsField[] = needFiles ? ["symbols", "files"] : ["symbols"];
  const facts = await loadFactsFields(opts, fields);

  let symbols: Symbol[];
  if (typeof query === "string") {
    // Use symbol_by_name index when available
    const index = await loadSymbolByName(cacheDir);
    if (index) {
      const ids = index[query] ?? [];
      const idSet = new Set(ids);
      symbols = facts.symbols.filter((s) => idSet.has(s.id));
    } else {
      symbols = facts.symbols.filter((s) => s.name === query);
    }
  } else {
    // For structured queries, use index only for name-only lookups
    if (query.name && !query.path && !query.id) {
      const index = await loadSymbolByName(cacheDir);
      if (index) {
        const ids = index[query.name] ?? [];
        const idSet = new Set(ids);
        symbols = facts.symbols.filter((s) => idSet.has(s.id));
        return { symbols };
      }
    }
    symbols = facts.symbols.filter((s) => {
      if (query.id && s.id !== query.id) return false;
      if (query.name && s.name !== query.name) return false;
      if (query.path) {
        // Match against file path in declaration
        const file = facts.files.find((f) => f.id === s.decl.file_id);
        if (
          !file ||
          (file.path !== query.path &&
            !file.path.endsWith(`/${query.path}`))
        )
          return false;
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
  const cacheDir = resolveCacheDir(opts);
  const index = await loadRefsBySymbol(cacheDir);
  if (index) {
    const refs = index[symbolId] ?? [];
    return { symbolId, refs };
  }
  // Fallback: load only refs
  const facts = await loadFactsFields(opts, ["refs"]);
  const refs = facts.refs.filter((r) => r.to_symbol_id === symbolId);
  return { symbolId, refs };
}

export async function queryDiagnostics(
  scope: "repo" | { unit: string } | { file: string },
  opts: QueryOptions,
): Promise<DiagnosticsResult> {
  // unit scope needs files to map unit→file_ids
  const fields: FactsField[] =
    scope !== "repo" && "unit" in scope
      ? ["diagnostics", "files"]
      : ["diagnostics"];
  const facts = await loadFactsFields(opts, fields);

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
  const facts = await loadFactsFields(opts, ["files", "deps"]);
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
  const facts = await loadFactsFields(opts, ["type_relations"]);
  const implementations = facts.type_relations.filter(
    (r) => r.to_type_id === typeId && r.kind === "implements",
  );
  return { typeId, implementations };
}

export async function queryCallers(
  symbolId: string,
  opts: QueryOptions,
): Promise<CallersResult> {
  const facts = await loadFactsFields(opts, ["call_edges"]);
  const callers = facts.call_edges.filter((e) => e.callee_id === symbolId);
  return { symbolId, callers };
}

export async function queryCallees(
  symbolId: string,
  opts: QueryOptions,
): Promise<CalleesResult> {
  const facts = await loadFactsFields(opts, ["call_edges"]);
  const callees = facts.call_edges.filter((e) => e.caller_id === symbolId);
  return { symbolId, callees };
}

/**
 * Detect dead code: exported symbols with zero incoming references.
 * Excludes entry points (main, init, TestXxx) and interface method implementations.
 */
export async function queryDeadCode(
  opts: QueryOptions,
): Promise<DeadCodeResult> {
  const facts = await loadFactsFields(opts, [
    "symbols", "refs", "call_edges", "type_relations",
  ]);

  // Build set of symbol IDs that are referenced
  const referencedIds = new Set<string>();
  for (const ref of facts.refs) {
    referencedIds.add(ref.to_symbol_id);
  }
  for (const edge of facts.call_edges) {
    referencedIds.add(edge.callee_id);
  }

  // Build set of symbol IDs that implement an interface (not dead even if unreferenced)
  // Include both the implementing type AND its methods (which satisfy the interface)
  const implementorIds = new Set<string>();
  for (const rel of facts.type_relations) {
    if (rel.kind === "implements") {
      implementorIds.add(rel.from_type_id);
    }
  }
  // Also exclude methods on implementing types (they exist to satisfy interfaces)
  for (const sym of facts.symbols) {
    if (sym.kind === "method" && sym.metadata?.receiver) {
      // Check if the receiver type implements any interface
      const receiverTypeId = facts.symbols.find(
        (s) => s.name === sym.metadata!.receiver && s.unit_id === sym.unit_id &&
               (s.kind === "struct" || s.kind === "type"),
      )?.id;
      if (receiverTypeId && implementorIds.has(receiverTypeId)) {
        implementorIds.add(sym.id);
      }
    }
  }

  // Entry point names to exclude
  const entryPointNames = new Set(["main", "init"]);

  const deadSymbols: DeadCodeResult["deadSymbols"] = [];

  for (const sym of facts.symbols) {
    // Only check exported symbols
    if (!sym.exported) continue;

    // Skip entry points
    if (entryPointNames.has(sym.name)) continue;

    // Skip Test/Benchmark/Example functions (Go test entry points)
    if (/^(Test|Benchmark|Example)/.test(sym.name)) continue;

    // Skip interface method implementations (the struct is used even if not directly referenced)
    if (implementorIds.has(sym.id)) continue;

    // Dead if not referenced
    if (!referencedIds.has(sym.id)) {
      deadSymbols.push({ symbol: sym, unitId: sym.unit_id });
    }
  }

  return { deadSymbols };
}

// FactsDelta merge and impact analysis — SPEC.md §7.1

import type {
  Facts,
  FactsDelta,
  Position,
} from "../schema/types.ts";

/**
 * Apply a FactsDelta to an existing Facts snapshot.
 * 1. Remove items listed in delta.removed (by id / composite key)
 * 2. Append items listed in delta.added
 * 3. Cascade: when a unit is removed, remove associated files/deps/symbols/refs/etc.
 * 4. Update snapshot.created_at
 */
export function applyDelta(facts: Facts, delta: FactsDelta): Facts {
  const result: Facts = structuredClone(facts);

  // --- Removals ---

  // Collect unit ids being removed for cascade
  const removedUnitIds = new Set(delta.removed.units ?? []);

  // Units
  if (removedUnitIds.size > 0) {
    result.units = result.units.filter((u) => !removedUnitIds.has(u.id));
  }

  // Files: explicit removal + cascade from units
  const removedFileIds = new Set(delta.removed.files ?? []);
  if (removedFileIds.size > 0 || removedUnitIds.size > 0) {
    result.files = result.files.filter(
      (f) => !removedFileIds.has(f.id) && !removedUnitIds.has(f.unit_id),
    );
  }
  // Collect all remaining file ids for cascading
  const cascadedFileIds = new Set(result.files.map((f) => f.id));

  // Symbols: explicit removal + cascade from units
  const removedSymbolIds = new Set(delta.removed.symbols ?? []);
  if (removedSymbolIds.size > 0 || removedUnitIds.size > 0) {
    result.symbols = result.symbols.filter(
      (s) => !removedSymbolIds.has(s.id) && !removedUnitIds.has(s.unit_id),
    );
  }
  const remainingSymbolIds = new Set(result.symbols.map((s) => s.id));

  // Deps: explicit removal + cascade from units
  const removedDeps = delta.removed.deps ?? [];
  const removedDepsSet = new Set(
    removedDeps.map((d) => `${d.from_unit_id}::${d.to_unit_id}`),
  );
  result.deps = result.deps.filter((d) => {
    if (removedUnitIds.has(d.from_unit_id) || removedUnitIds.has(d.to_unit_id))
      return false;
    if (removedDepsSet.has(`${d.from_unit_id}::${d.to_unit_id}`)) return false;
    return true;
  });

  // Refs: explicit removal + cascade from symbols
  const removedRefs = delta.removed.refs ?? [];
  const removedRefsSet = new Set(
    removedRefs.map((r) => `${r.from_symbol_id}::${r.to_symbol_id}`),
  );
  result.refs = result.refs.filter((r) => {
    if (
      !remainingSymbolIds.has(r.from_symbol_id) ||
      !remainingSymbolIds.has(r.to_symbol_id)
    )
      return false;
    if (removedRefsSet.has(`${r.from_symbol_id}::${r.to_symbol_id}`))
      return false;
    return true;
  });

  // TypeRelations: explicit removal + cascade from symbols
  const removedTypeRels = delta.removed.type_relations ?? [];
  const removedTypeRelsSet = new Set(
    removedTypeRels.map((r) => `${r.from_type_id}::${r.to_type_id}`),
  );
  result.type_relations = result.type_relations.filter((r) => {
    if (
      !remainingSymbolIds.has(r.from_type_id) ||
      !remainingSymbolIds.has(r.to_type_id)
    )
      return false;
    if (removedTypeRelsSet.has(`${r.from_type_id}::${r.to_type_id}`))
      return false;
    return true;
  });

  // CallEdges: explicit removal + cascade from symbols
  const removedCallEdges = delta.removed.call_edges ?? [];
  const removedCallEdgesSet = new Set(
    removedCallEdges.map((e) => `${e.caller_id}::${e.callee_id}`),
  );
  result.call_edges = result.call_edges.filter((e) => {
    if (
      !remainingSymbolIds.has(e.caller_id) ||
      !remainingSymbolIds.has(e.callee_id)
    )
      return false;
    if (removedCallEdgesSet.has(`${e.caller_id}::${e.callee_id}`))
      return false;
    return true;
  });

  // Diagnostics: explicit removal + cascade from files
  const removedDiags = delta.removed.diagnostics ?? [];
  result.diagnostics = result.diagnostics.filter((d) => {
    if (!cascadedFileIds.has(d.file_id)) return false;
    for (const rd of removedDiags) {
      if (
        d.file_id === rd.file_id &&
        positionEqual(d.position, rd.position) &&
        d.message === rd.message
      )
        return false;
    }
    return true;
  });

  // --- Additions ---
  if (delta.added.units) result.units.push(...delta.added.units);
  if (delta.added.files) result.files.push(...delta.added.files);
  if (delta.added.deps) result.deps.push(...delta.added.deps);
  if (delta.added.symbols) result.symbols.push(...delta.added.symbols);
  if (delta.added.refs) result.refs.push(...delta.added.refs);
  if (delta.added.type_relations)
    result.type_relations.push(...delta.added.type_relations);
  if (delta.added.call_edges)
    result.call_edges.push(...delta.added.call_edges);
  if (delta.added.diagnostics)
    result.diagnostics.push(...delta.added.diagnostics);

  // Update timestamp
  result.snapshot.created_at = new Date().toISOString();

  return result;
}

/**
 * Given a list of changed file paths and the current Facts,
 * determine which unit IDs are affected.
 */
export function impactUnits(
  changedFiles: string[],
  facts: Facts,
): string[] {
  const changedFileIds = new Set(
    changedFiles.map((f) => (f.startsWith("file:") ? f : `file:${f}`)),
  );

  const affectedUnitIds = new Set<string>();
  for (const file of facts.files) {
    if (changedFileIds.has(file.id)) {
      affectedUnitIds.add(file.unit_id);
    }
  }

  return [...affectedUnitIds];
}

function positionEqual(a: Position, b: Position): boolean {
  return a.line === b.line && a.column === b.column;
}

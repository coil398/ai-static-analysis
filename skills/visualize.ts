// visualize-graph skill — render facts as Mermaid or DOT graphs.
//
// Two graph kinds are supported:
//   - "deps":     unit-level dependency graph (one node per Unit, edges from facts.deps)
//   - "callgraph": symbol-level call graph (one node per Symbol, edges from facts.call_edges)
//
// Output is intentionally pure text (no I/O) so callers can pipe it into
// `dot`, embed it in Markdown / GitHub PR comments, or post-process further.

import { join } from "node:path";
import type { Facts } from "../core/schema/types.ts";
import { readFactsPartial } from "../core/storage/index.ts";
import type { FactsField } from "../core/storage/index.ts";

export type GraphKind = "deps" | "callgraph";
export type GraphFormat = "mermaid" | "dot";

export interface VisualizeOptions {
  repoRoot: string;
  cacheDir?: string;
  /** "deps" (default) or "callgraph". */
  kind?: GraphKind;
  /** "mermaid" (default) or "dot". */
  format?: GraphFormat;
  /** Filter: only include units/symbols whose id is in this allow list. */
  include?: string[];
  /**
   * Filter: only include units/symbols whose id matches one of these substrings.
   * Both `include` and `match` may be specified; a node passes if either matches.
   */
  match?: string[];
  /** Cap the number of edges rendered (avoids producing unviewable graphs). */
  maxEdges?: number;
}

export interface VisualizeResult {
  format: GraphFormat;
  kind: GraphKind;
  /** The rendered graph text. */
  graph: string;
  /** Counts after filtering, useful when the caller wants to surface truncation. */
  nodeCount: number;
  edgeCount: number;
  /** True when maxEdges caused edges to be dropped. */
  truncated: boolean;
}

function resolveCacheDir(opts: VisualizeOptions): string {
  return opts.cacheDir ?? join(opts.repoRoot, "cache");
}

/**
 * Sanitize a node id for use in DOT / Mermaid identifier slots.
 * Both formats need stable, simple identifiers — we replace anything that
 * isn't [A-Za-z0-9_] and prefix with `n` so the id can't start with a digit.
 */
function nodeKey(id: string): string {
  return "n" + id.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Escape a label for use as a quoted DOT / Mermaid string. */
function escapeLabel(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function passesFilter(
  id: string,
  include: Set<string> | null,
  match: string[] | null,
): boolean {
  if (!include && !match) return true;
  if (include?.has(id)) return true;
  if (match) {
    for (const needle of match) {
      if (id.includes(needle)) return true;
    }
  }
  return false;
}

interface GraphEdge {
  from: string;
  to: string;
  kind?: string;
}

interface GraphNode {
  id: string;
  label: string;
}

function renderMermaid(nodes: GraphNode[], edges: GraphEdge[]): string {
  const lines = ["graph LR"];
  for (const n of nodes) {
    lines.push(`  ${nodeKey(n.id)}["${escapeLabel(n.label)}"]`);
  }
  for (const e of edges) {
    const label = e.kind ? `|${escapeLabel(e.kind)}|` : "";
    lines.push(`  ${nodeKey(e.from)} -->${label} ${nodeKey(e.to)}`);
  }
  return lines.join("\n");
}

function renderDot(nodes: GraphNode[], edges: GraphEdge[]): string {
  const lines = ["digraph G {", "  rankdir=LR;"];
  for (const n of nodes) {
    lines.push(`  ${nodeKey(n.id)} [label="${escapeLabel(n.label)}"];`);
  }
  for (const e of edges) {
    const attr = e.kind ? ` [label="${escapeLabel(e.kind)}"]` : "";
    lines.push(`  ${nodeKey(e.from)} -> ${nodeKey(e.to)}${attr};`);
  }
  lines.push("}");
  return lines.join("\n");
}

function buildDepsGraph(
  facts: Facts,
  include: Set<string> | null,
  match: string[] | null,
  maxEdges: number,
): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
  const visibleUnits = new Set<string>();
  const edges: GraphEdge[] = [];
  let truncated = false;
  for (const dep of facts.deps) {
    if (
      !passesFilter(dep.from_unit_id, include, match) ||
      !passesFilter(dep.to_unit_id, include, match)
    ) {
      continue;
    }
    if (edges.length >= maxEdges) {
      truncated = true;
      break;
    }
    edges.push({ from: dep.from_unit_id, to: dep.to_unit_id, kind: dep.kind });
    visibleUnits.add(dep.from_unit_id);
    visibleUnits.add(dep.to_unit_id);
  }
  const nodes: GraphNode[] = facts.units
    .filter((u) => visibleUnits.has(u.id))
    .map((u) => ({ id: u.id, label: u.name || u.id }));
  return { nodes, edges, truncated };
}

function buildCallGraph(
  facts: Facts,
  include: Set<string> | null,
  match: string[] | null,
  maxEdges: number,
): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
  const symbolById = new Map(facts.symbols.map((s) => [s.id, s]));
  const visibleSymbols = new Set<string>();
  const edges: GraphEdge[] = [];
  let truncated = false;
  for (const edge of facts.call_edges) {
    if (
      !passesFilter(edge.caller_id, include, match) ||
      !passesFilter(edge.callee_id, include, match)
    ) {
      continue;
    }
    if (edges.length >= maxEdges) {
      truncated = true;
      break;
    }
    edges.push({
      from: edge.caller_id,
      to: edge.callee_id,
      kind: edge.dispatch,
    });
    visibleSymbols.add(edge.caller_id);
    visibleSymbols.add(edge.callee_id);
  }
  const nodes: GraphNode[] = [];
  for (const id of visibleSymbols) {
    const sym = symbolById.get(id);
    nodes.push({ id, label: sym ? sym.name : id });
  }
  return { nodes, edges, truncated };
}

const DEFAULT_MAX_EDGES = 500;

export async function visualizeGraph(
  opts: VisualizeOptions,
): Promise<VisualizeResult> {
  const cacheDir = resolveCacheDir(opts);
  const kind = opts.kind ?? "deps";
  const format = opts.format ?? "mermaid";
  const maxEdges = opts.maxEdges ?? DEFAULT_MAX_EDGES;
  const include = opts.include?.length ? new Set(opts.include) : null;
  const match = opts.match?.length ? opts.match : null;

  const fields: FactsField[] =
    kind === "deps"
      ? ["units", "deps"]
      : ["symbols", "call_edges"];
  const facts = await readFactsPartial(cacheDir, fields);
  if (!facts) {
    throw new Error(
      `No cached facts found. Run index-facts first. (cacheDir: ${cacheDir})`,
    );
  }

  const { nodes, edges, truncated } =
    kind === "deps"
      ? buildDepsGraph(facts, include, match, maxEdges)
      : buildCallGraph(facts, include, match, maxEdges);

  const graph =
    format === "mermaid" ? renderMermaid(nodes, edges) : renderDot(nodes, edges);

  return {
    format,
    kind,
    graph,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    truncated,
  };
}

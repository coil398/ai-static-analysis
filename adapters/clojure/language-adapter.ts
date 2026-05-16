// ClojureLanguageAdapter — CLOJURE_SPEC.md
//
// Strategy:
//   - detect: deps.edn, project.clj, build.boot, shadow-cljs.edn, bb.edn
//   - enumerateUnits: each project root (file containing one of the markers
//     above) becomes one unit. Single-project Clojure layouts collapse to
//     unit:clojure:.
//   - indexUnits: collect .clj/.cljs/.cljc files under each unit's :paths /
//     source-paths, parse ns + (:require ...) to compute namespace-level
//     refs (intra-unit), and drive clojure-lsp for LSP-backed symbols /
//     refs / call_edges. type_relations is not surfaced (Clojure is not
//     class-based).
//   - diagnose: clj-kondo when available (also bundled inside clojure-lsp).

import { basename, relative, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type {
  LanguageAdapter,
  DetectResult,
  DoctorResult,
  BootstrapResult,
} from "../../core/adapter/types.ts";
import type {
  Unit,
  File,
  Dep,
  Symbol,
  Ref,
  TypeRelation,
  CallEdge,
  FactsDelta,
  Diagnostic,
} from "../../core/schema/types.ts";
import {
  exec,
  whichTool,
  hashFile,
  isGenerated,
  hashSig,
  collectFiles,
  detectCyclicDeps,
  LspClient,
  type LspDocumentSymbol,
} from "../shared/index.ts";

const CLJ_EXT = [".clj", ".cljs", ".cljc", ".edn"];
const CLJ_SOURCE_EXT = [".clj", ".cljs", ".cljc"];

// clojure-lsp uses standard LSP SymbolKinds; map function-like and class-like
// onto Clojure terminology.
const CLOJURE_SYMBOL_KIND_MAP: Record<number, string> = {
  2: "namespace",
  3: "namespace",
  5: "type",       // defrecord / deftype
  6: "function",   // defn (sometimes reported as method)
  12: "function",  // defn
  13: "var",       // def
  14: "constant",  // def with metadata
  22: "type",
};

interface ProjectRoot {
  /** Path relative to repoRoot. "." for the root project. */
  relPath: string;
  /** Marker file basename (deps.edn / project.clj / etc.) */
  marker: string;
  /** Source paths declared by the project, repoRoot-relative. */
  sourcePaths: string[];
}

export class ClojureLanguageAdapter implements LanguageAdapter {
  readonly lang = "clojure";

  private externalClient: LspClient | null = null;
  setExternalLspClient(client: LspClient | null): void {
    this.externalClient = client;
  }

  async detect(repoRoot: string): Promise<DetectResult> {
    const markers = ["deps.edn", "project.clj", "build.boot", "shadow-cljs.edn", "bb.edn"];
    for (const m of markers) {
      if (await Bun.file(resolve(repoRoot, m)).exists()) {
        return { supported: true, confidence: 1.0 };
      }
    }
    if (await hasAnyClj(repoRoot)) {
      return { supported: true, confidence: 0.5 };
    }
    return { supported: false, confidence: 0 };
  }

  async doctor(): Promise<DoctorResult> {
    const missing: string[] = [];
    const notes: string[] = [];

    const java = await whichTool("java");
    if (!java) {
      missing.push("java");
    } else {
      const v = await exec(["java", "-version"]);
      const first = (v.stderr || v.stdout).split("\n")[0] ?? "";
      if (first) notes.push(first);
    }

    const optional = [
      { name: "clojure", purpose: "build / test driver (tools.deps)" },
      { name: "clj", purpose: "build / test driver (tools.deps shorthand)" },
      { name: "lein", purpose: "build / test driver (Leiningen)" },
      { name: "clojure-lsp", purpose: "symbols/refs/call_edges (LSP)" },
      { name: "clj-kondo", purpose: "static analysis (diagnose)" },
      { name: "cljfmt", purpose: "formatter" },
    ];
    for (const { name, purpose } of optional) {
      if (!(await whichTool(name))) {
        notes.push(`${name} not found (optional, needed for ${purpose})`);
      } else {
        notes.push(`${name}: available`);
      }
    }
    return { ok: missing.length === 0, missing_tools: missing, notes };
  }

  async bootstrap(): Promise<BootstrapResult> {
    return {
      installed: [],
      failed: [],
      notes: [
        "Clojure tooling install paths vary by OS. Suggested commands:",
        "  - JDK: install via OS package manager or sdkman (`sdk install java`)",
        "  - Clojure CLI: https://clojure.org/guides/install_clojure",
        "  - clojure-lsp: download from https://github.com/clojure-lsp/clojure-lsp/releases (native static binary)",
        "  - clj-kondo: https://github.com/clj-kondo/clj-kondo/releases",
      ],
    };
  }

  async enumerateUnits(
    repoRoot: string,
    _profile: Record<string, string>,
  ): Promise<Unit[]> {
    const roots = await findProjectRoots(repoRoot);
    if (roots.length === 0) {
      if (await hasAnyClj(repoRoot)) {
        return [
          {
            id: "unit:clojure:.",
            kind: "clojure_project",
            name: basename(repoRoot),
            path: ".",
            metadata: { repo_root: repoRoot, source_paths: ["src"], marker: "auto" },
          },
        ];
      }
      return [];
    }
    return roots.map((r) => ({
      id: r.relPath === "." ? "unit:clojure:." : `unit:clojure:${r.relPath}`,
      kind: "clojure_project",
      name: r.relPath === "." ? basename(repoRoot) : basename(r.relPath),
      path: r.relPath,
      metadata: {
        repo_root: repoRoot,
        source_paths: r.sourcePaths,
        marker: r.marker,
      },
    }));
  }

  async indexUnits(
    units: Unit[],
    _profile: Record<string, string>,
  ): Promise<FactsDelta> {
    const repoRoot = units[0]?.metadata?.["repo_root"] as string | undefined;
    if (!repoRoot) {
      throw new Error("units must contain repo_root in metadata");
    }

    const files: File[] = [];
    const cljFiles: Array<{ relPath: string; unitId: string; ns: string | null }> = [];

    // Pass 1: collect files + namespaces.
    const nsToUnit = new Map<string, string>();
    for (const u of units) {
      const sourcePaths = (u.metadata?.["source_paths"] as string[] | undefined) ?? ["src"];
      for (const srcRel of sourcePaths) {
        const absDir = resolve(repoRoot, u.path === "." ? srcRel : `${u.path}/${srcRel}`);
        if (!(await dirExists(absDir))) continue;
        const collected = await collectFiles(absDir, CLJ_EXT, repoRoot);
        for (const relPath of collected) {
          const absPath = resolve(repoRoot, relPath);
          const [hash, generated] = await Promise.all([
            hashFile(absPath),
            isGenerated(absPath),
          ]);
          files.push({
            id: `file:${relPath}`,
            path: relPath,
            unit_id: u.id,
            hash,
            generated,
          });
          if (generated) continue;
          if (!CLJ_SOURCE_EXT.some((e) => relPath.endsWith(e))) continue;
          const text = await safeRead(absPath);
          const ns = text === null ? null : parseNamespace(text);
          if (ns) nsToUnit.set(ns, u.id);
          cljFiles.push({ relPath, unitId: u.id, ns });
        }
      }
    }

    // Pass 2: parse (:require ...) per file → namespace-level refs.
    const deps: Dep[] = [];
    const seenDep = new Set<string>();
    for (const { relPath, unitId } of cljFiles) {
      const text = await safeRead(resolve(repoRoot, relPath));
      if (text === null) continue;
      for (const required of parseRequires(text)) {
        const owner = nsToUnit.get(required);
        if (!owner || owner === unitId) continue;
        const key = `${unitId}->${owner}`;
        if (seenDep.has(key)) continue;
        seenDep.add(key);
        deps.push({
          from_unit_id: unitId,
          to_unit_id: owner,
          kind: "require",
        });
      }
    }

    let symbols: Symbol[] = [];
    let refs: Ref[] = [];
    let typeRelations: TypeRelation[] = [];
    let callEdges: CallEdge[] = [];

    const lsp = await this.indexWithClojureLsp(
      repoRoot,
      cljFiles.map(({ relPath, unitId }) => ({ relPath, unitId })),
      new Set(units.map((u) => u.id)),
    );
    // Prefer LSP when non-empty; otherwise parser fallback. clojure-lsp may
    // return [] for documentSymbol before it has finished its first project
    // scan even though our probe loop reported a non-empty result against
    // the probe file.
    if (lsp.ran && lsp.symbols.length > 0) {
      symbols = lsp.symbols;
      refs = lsp.refs;
      typeRelations = lsp.typeRelations;
      callEdges = lsp.callEdges;
    } else {
      for (const { relPath, unitId } of cljFiles) {
        const text = await safeRead(resolve(repoRoot, relPath));
        if (text === null) continue;
        symbols.push(...parseTopLevelDefs(text, unitId, relPath));
      }
    }

    return {
      added: {
        units,
        files,
        deps,
        symbols,
        refs,
        type_relations: typeRelations,
        call_edges: callEdges,
      },
      removed: {},
    };
  }

  private async indexWithClojureLsp(
    repoRoot: string,
    cljFiles: Array<{ relPath: string; unitId: string }>,
    unitIds: Set<string>,
  ): Promise<{
    ran: boolean;
    symbols: Symbol[];
    refs: Ref[];
    typeRelations: TypeRelation[];
    callEdges: CallEdge[];
  }> {
    const empty = { symbols: [], refs: [], typeRelations: [], callEdges: [] };
    if (cljFiles.length === 0) return { ran: false, ...empty };
    if (!this.externalClient && (await whichTool("clojure-lsp")) === null) {
      return { ran: false, ...empty };
    }
    const client =
      this.externalClient ??
      new LspClient(["clojure-lsp"], repoRoot);
    const ownClient = this.externalClient === null;
    try {
      return {
        ran: true,
        ...(await runClojureLspIndexing(repoRoot, cljFiles, unitIds, client)),
      };
    } catch {
      return { ran: true, ...empty };
    } finally {
      if (ownClient) {
        try { await client.shutdown(); } catch { /* ignore */ }
      }
    }
  }

  async diagnose(
    units: Unit[],
    profile: Record<string, string>,
    inputDeps?: Dep[],
  ): Promise<Diagnostic[]> {
    const repoRoot = units[0]?.metadata?.["repo_root"] as string | undefined;
    if (!repoRoot) return [];

    const diagnostics: Diagnostic[] = [];
    const deps =
      inputDeps ??
      (await this.indexUnits(units, profile)).added.deps ??
      [];
    diagnostics.push(...detectCyclicDeps(deps, "unit:clojure:"));

    if (await whichTool("clj-kondo")) {
      const r = await exec(
        ["clj-kondo", "--lint", ".", "--config", '{:output {:format :json}}'],
        { cwd: repoRoot },
      );
      diagnostics.push(...parseCljKondoJson(r.stdout, repoRoot));
    }
    return diagnostics;
  }
}

// --- helpers (exported for tests) ---

async function safeRead(path: string): Promise<string | null> {
  try { return await Bun.file(path).text(); } catch { return null; }
}

async function dirExists(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

async function hasAnyClj(root: string): Promise<boolean> {
  async function walk(dir: string, depth: number): Promise<boolean> {
    if (depth > 3) return false;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "target" || e.name === "node_modules") continue;
      if (e.isDirectory()) {
        if (await walk(resolve(dir, e.name), depth + 1)) return true;
      } else if (CLJ_SOURCE_EXT.some((x) => e.name.endsWith(x))) {
        return true;
      }
    }
    return false;
  }
  return walk(root, 0);
}

async function findProjectRoots(repoRoot: string): Promise<ProjectRoot[]> {
  const markers = ["deps.edn", "project.clj", "shadow-cljs.edn", "bb.edn", "build.boot"];
  const roots: ProjectRoot[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    let foundMarker: string | null = null;
    for (const e of entries) {
      if (!e.isDirectory() && markers.includes(e.name)) {
        foundMarker = e.name;
        break;
      }
    }
    if (foundMarker) {
      const relPath = dir === repoRoot ? "." : relative(repoRoot, dir);
      const markerPath = resolve(dir, foundMarker);
      const text = await safeRead(markerPath);
      const sourcePaths = text === null ? ["src"] : extractSourcePaths(text, foundMarker);
      roots.push({ relPath, marker: foundMarker, sourcePaths });
      // Do not recurse into nested projects; one project per root is enough.
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") || e.name === "target" || e.name === "node_modules") continue;
      await walk(resolve(dir, e.name), depth + 1);
    }
  }
  await walk(repoRoot, 0);
  return roots;
}

/**
 * Extract source paths from a project marker file. Robust enough for the
 * common `:paths ["src" "resources"]` form in deps.edn and the `:source-paths`
 * form in project.clj. Falls back to ["src"] when nothing matches — that
 * mirrors the Leiningen / tools.deps default.
 */
export function extractSourcePaths(text: string, marker: string): string[] {
  let m: RegExpExecArray | null;
  if (marker === "deps.edn" || marker === "shadow-cljs.edn" || marker === "bb.edn") {
    // :paths ["src" "resources"]
    m = /:paths\s+\[([^\]]*)\]/.exec(text);
    if (m) return parseEdnStringVector(m[1]!);
    // :extra-paths fallback
    m = /:extra-paths\s+\[([^\]]*)\]/.exec(text);
    if (m) return parseEdnStringVector(m[1]!);
  }
  if (marker === "project.clj") {
    m = /:source-paths\s+\[([^\]]*)\]/.exec(text);
    if (m) return parseEdnStringVector(m[1]!);
  }
  if (marker === "build.boot") {
    m = /:source-paths\s+#\{([^}]*)\}/.exec(text);
    if (m) return parseEdnStringVector(m[1]!);
  }
  return ["src"];
}

function parseEdnStringVector(body: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1]!);
  return out;
}

const NS_RE = /\(\s*ns\s+([\w.\-?!*+<>=]+)/;

/** Recover the namespace declared at the top of a Clojure source file. */
export function parseNamespace(text: string): string | null {
  const m = NS_RE.exec(text);
  return m ? m[1]! : null;
}

const REQUIRE_RE = /:require\s+([\s\S]*?)(?=\)|\(:|$)/g;
const REQUIRE_ITEM_RE =
  /\[\s*([\w.\-?!*+<>=]+)|\b([\w.\-?!*+<>=]+)\b/g;

/**
 * Parse `(:require ...)` and `(:use ...)` forms, returning the namespaces
 * they pull in. Handles `[foo.bar :as f]`, `[foo.bar :refer [baz]]`, plain
 * symbols, and a vector-of-vectors body.
 */
export function parseRequires(text: string): string[] {
  const out = new Set<string>();
  REQUIRE_RE.lastIndex = 0;
  let req: RegExpExecArray | null;
  while ((req = REQUIRE_RE.exec(text)) !== null) {
    const body = req[1]!;
    REQUIRE_ITEM_RE.lastIndex = 0;
    let item: RegExpExecArray | null;
    while ((item = REQUIRE_ITEM_RE.exec(body)) !== null) {
      const name = item[1] ?? item[2];
      if (!name) continue;
      // Skip option keywords (`:as`, `:refer`, etc.).
      if (name.startsWith(":")) continue;
      // Skip bareword tokens that look like option names by convention.
      if (name === "as" || name === "refer" || name === "rename") continue;
      // Keep only dotted namespace-shaped tokens (must contain at least one '.').
      if (!name.includes(".")) continue;
      out.add(name);
    }
  }
  return [...out];
}

const DEFN_RE = /\(\s*(?:defn|defn-|defmacro|defmulti)\s+([\w.\-?!*+<>=]+)/g;
const DEF_RE = /\(\s*def\s+([\w.\-?!*+<>=]+)/g;

/** Fallback symbol scan when clojure-lsp is unavailable. */
export function parseTopLevelDefs(
  source: string,
  unitId: string,
  relPath: string,
): Symbol[] {
  const out: Symbol[] = [];
  const unitPath = unitId.replace(/^unit:clojure:/, "");
  const ns = parseNamespace(source);

  function pushDef(name: string, kind: string, offset: number) {
    let line = 1;
    let lastNl = -1;
    for (let i = 0; i < offset; i++) {
      if (source.charCodeAt(i) === 10) {
        line++;
        lastNl = i;
      }
    }
    const column = offset - lastNl;
    const sigHash = hashSig(`${name}:${kind}:${line}`);
    out.push({
      id: `sym:clojure:${unitPath}#${kind}#${name}#sig:${sigHash}`,
      unit_id: unitId,
      name,
      kind,
      exported: !name.startsWith("-") && !name.endsWith("-"),
      decl: {
        file_id: `file:${relPath}`,
        position: { line, column },
      },
      metadata: ns ? { namespace: ns } : undefined,
    });
  }

  DEFN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEFN_RE.exec(source)) !== null) {
    pushDef(m[1]!, "function", m.index);
  }
  DEF_RE.lastIndex = 0;
  while ((m = DEF_RE.exec(source)) !== null) {
    pushDef(m[1]!, "var", m.index);
  }
  return out;
}

async function runClojureLspIndexing(
  repoRoot: string,
  cljFiles: Array<{ relPath: string; unitId: string }>,
  unitIds: Set<string>,
  client: LspClient,
): Promise<{
  symbols: Symbol[];
  refs: Ref[];
  typeRelations: TypeRelation[];
  callEdges: CallEdge[];
}> {
  const symbols: Symbol[] = [];
  const refs: Ref[] = [];
  const typeRelations: TypeRelation[] = [];
  const callEdges: CallEdge[] = [];
  const symbolByPos = new Map<string, Symbol>();
  const funcSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];
  const refTargets: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];

  for (const { relPath } of cljFiles) {
    try { await client.openDocument(relPath, "clojure"); }
    catch { /* ignore */ }
  }

  // clojure-lsp indexes the project on startup; probe before main pass.
  const probe = cljFiles[0]?.relPath;
  if (probe) {
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      try {
        const res = await client.documentSymbols(probe, 5_000);
        if (res.length > 0) break;
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  for (const { relPath, unitId } of cljFiles) {
    let lspSyms: LspDocumentSymbol[];
    try { lspSyms = await client.documentSymbols(relPath); } catch { continue; }
    for (const lspSym of flattenSymbols(lspSyms)) {
      const kind = CLOJURE_SYMBOL_KIND_MAP[lspSym.kind];
      if (!kind) continue;
      const line = lspSym.selectionRange.start.line;
      const col = lspSym.selectionRange.start.character;
      const sym = lspSymbolToCljSymbol(lspSym, kind, relPath, unitId);
      symbols.push(sym);
      symbolByPos.set(`${relPath}:${line}:${col}`, sym);
      if (kind === "function") {
        funcSymbols.push({ symbol: sym, relPath, line, col });
        refTargets.push({ symbol: sym, relPath, line, col });
      }
      if (kind === "var" || kind === "constant" || kind === "type") {
        refTargets.push({ symbol: sym, relPath, line, col });
      }
    }
  }

  for (const { symbol, relPath, line, col } of funcSymbols) {
    let items;
    try { items = await client.prepareCallHierarchy(relPath, line, col); }
    catch { continue; }
    for (const item of items) {
      let outgoing;
      try { outgoing = await client.outgoingCalls(item); } catch { continue; }
      for (const call of outgoing) {
        const calleeRelPath = relative(repoRoot, LspClient.uriToPath(call.to.uri));
        const calleeSym =
          symbolByPos.get(`${calleeRelPath}:${call.to.selectionRange.start.line}:${call.to.selectionRange.start.character}`) ??
          symbolByPos.get(`${calleeRelPath}:${call.to.range.start.line}:${call.to.range.start.character}`);
        if (!calleeSym) continue;
        if (!unitIds.has(calleeSym.unit_id)) continue;
        const callerFileId = `file:${relPath}`;
        for (const range of call.fromRanges) {
          callEdges.push({
            caller_id: symbol.id,
            callee_id: calleeSym.id,
            site: {
              file_id: callerFileId,
              position: { line: range.start.line + 1, column: range.start.character + 1 },
            },
            dispatch: "dynamic",
          });
          refs.push({
            from_symbol_id: symbol.id,
            to_symbol_id: calleeSym.id,
            site: {
              file_id: callerFileId,
              position: { line: range.start.line + 1, column: range.start.character + 1 },
            },
            kind: "call",
            confidence: "certain",
          });
        }
      }
    }
  }

  const callRefKeys = new Set(
    refs.map((r) => `${r.to_symbol_id}@${r.site.file_id}:${r.site.position.line}:${r.site.position.column}`),
  );
  for (const { symbol: targetSym, relPath: tRelPath, line: tLine, col: tCol } of refTargets) {
    let locs;
    try { locs = await client.references(tRelPath, tLine, tCol); } catch { continue; }
    for (const loc of locs) {
      const locRelPath = relative(repoRoot, LspClient.uriToPath(loc.uri));
      if (
        locRelPath === tRelPath &&
        loc.range.start.line === tLine &&
        loc.range.start.character === tCol
      ) continue;
      const fileId = `file:${locRelPath}`;
      const locLine = loc.range.start.line + 1;
      const locCol = loc.range.start.character + 1;
      const refKey = `${targetSym.id}@${fileId}:${locLine}:${locCol}`;
      if (callRefKeys.has(refKey)) continue;
      const fromSymbol = findEnclosingSymbol(symbols, fileId, locLine);
      refs.push({
        from_symbol_id: fromSymbol?.id ?? `file_scope:${locRelPath}`,
        to_symbol_id: targetSym.id,
        site: {
          file_id: fileId,
          position: { line: locLine, column: locCol },
        },
        kind: "reference",
        confidence: "certain",
      });
    }
  }

  return { symbols, refs, typeRelations, callEdges };
}

function flattenSymbols(syms: LspDocumentSymbol[]): LspDocumentSymbol[] {
  const out: LspDocumentSymbol[] = [];
  for (const s of syms) {
    out.push(s);
    if (s.children?.length) out.push(...flattenSymbols(s.children));
  }
  return out;
}

function lspSymbolToCljSymbol(
  lspSym: LspDocumentSymbol,
  kind: string,
  relPath: string,
  unitId: string,
): Symbol {
  const line = lspSym.selectionRange.start.line;
  const col = lspSym.selectionRange.start.character;
  const unitPath = unitId.replace(/^unit:clojure:/, "");
  const sigHash = hashSig(`${lspSym.name}:${lspSym.kind}:${line}`);
  return {
    id: `sym:clojure:${unitPath}#${kind}#${lspSym.name}#sig:${sigHash}`,
    unit_id: unitId,
    name: lspSym.name,
    kind,
    // Clojure private vars are named with the `defn-` form (we cannot tell
    // from documentSymbol). Default to true; the parser fallback applies a
    // smarter heuristic.
    exported: true,
    decl: {
      file_id: `file:${relPath}`,
      position: { line: line + 1, column: col + 1 },
    },
  };
}

function findEnclosingSymbol(
  symbols: Symbol[],
  fileId: string,
  line: number,
): Symbol | null {
  const fns = symbols
    .filter(
      (s) => s.decl.file_id === fileId && s.kind === "function",
    )
    .sort((a, b) => a.decl.position.line - b.decl.position.line);
  for (let i = 0; i < fns.length; i++) {
    const sym = fns[i]!;
    const next = i + 1 < fns.length ? fns[i + 1]!.decl.position.line : Infinity;
    if (sym.decl.position.line <= line && line < next) return sym;
  }
  return null;
}

interface CljKondoFinding {
  filename?: string;
  type?: string;
  level?: string;
  row?: number;
  col?: number;
  message?: string;
}

export function parseCljKondoJson(stdout: string, repoRoot: string): Diagnostic[] {
  if (!stdout.trim()) return [];
  let payload: { findings?: CljKondoFinding[] };
  try {
    payload = JSON.parse(stdout);
  } catch {
    return [];
  }
  const out: Diagnostic[] = [];
  for (const f of payload.findings ?? []) {
    if (!f.filename || !f.row) continue;
    const rel = relative(repoRoot, resolve(repoRoot, f.filename));
    if (rel.startsWith("..")) continue;
    const severity: Diagnostic["severity"] =
      f.level === "error" ? "error"
      : f.level === "warning" ? "warning"
      : "info";
    out.push({
      file_id: `file:${rel}`,
      position: { line: f.row, column: f.col ?? 1 },
      severity,
      message: `${f.type ?? "lint"}: ${f.message ?? ""}`,
      tool: "clj-kondo",
    });
  }
  return out;
}

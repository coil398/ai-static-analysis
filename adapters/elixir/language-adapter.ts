// ElixirLanguageAdapter — ELIXIR_SPEC.md
//
// Strategy:
//   - detect: mix.exs (single app) or apps/ with per-app mix.exs (umbrella).
//   - enumerateUnits: each mix.exs becomes one unit. Umbrella roots emit one
//     unit per app; single-project mix.exs emits unit:elixir:.
//   - indexUnits: collect .ex/.exs files under lib/ and test/, parse module
//     declarations + `alias`/`import` for module-level deps, and drive
//     elixir-ls for LSP-backed symbols / refs / call_edges.
//   - diagnose: credo when available.

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

const EX_EXT = [".ex", ".exs"];

const ELIXIR_SYMBOL_KIND_MAP: Record<number, string> = {
  2: "module",
  3: "namespace",
  5: "module",
  6: "function",
  12: "function",
  13: "variable",
  14: "constant",
  22: "struct",
};

export class ElixirLanguageAdapter implements LanguageAdapter {
  readonly lang = "elixir";

  private externalClient: LspClient | null = null;
  setExternalLspClient(client: LspClient | null): void {
    this.externalClient = client;
  }

  async detect(repoRoot: string): Promise<DetectResult> {
    if (await Bun.file(resolve(repoRoot, "mix.exs")).exists()) {
      return { supported: true, confidence: 1.0 };
    }
    if (await dirExists(resolve(repoRoot, "apps"))) {
      return { supported: true, confidence: 0.8 };
    }
    if (await hasAnyEx(repoRoot)) {
      return { supported: true, confidence: 0.4 };
    }
    return { supported: false, confidence: 0 };
  }

  async doctor(): Promise<DoctorResult> {
    const missing: string[] = [];
    const notes: string[] = [];

    const elixir = await whichTool("elixir");
    if (!elixir) {
      missing.push("elixir");
    } else {
      const v = await exec(["elixir", "--version"]);
      // Pick the line containing "Elixir".
      const line = (v.stdout || v.stderr)
        .split("\n")
        .find((l) => l.includes("Elixir")) ?? "";
      if (line) notes.push(line.trim());
    }

    const optional = [
      { name: "mix", purpose: "build / test driver" },
      { name: "elixir-ls", purpose: "symbols/refs/call_edges (LSP wrapper)" },
      { name: "language_server.sh", purpose: "elixir-ls launcher (alternative)" },
      { name: "credo", purpose: "static analysis (diagnose)" },
      { name: "mix_format", purpose: "formatter (via mix format)" },
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
        "Elixir toolchain install paths vary by OS. Suggested commands:",
        "  - Elixir + Erlang/OTP: `apt install elixir` or `brew install elixir`",
        "  - elixir-ls: download from https://github.com/elixir-lsp/elixir-ls/releases (then add language_server.sh to PATH)",
        "  - credo: `mix archive.install hex credo`",
      ],
    };
  }

  async enumerateUnits(
    repoRoot: string,
    _profile: Record<string, string>,
  ): Promise<Unit[]> {
    const appsDir = resolve(repoRoot, "apps");
    if (await dirExists(appsDir)) {
      // Umbrella project: each subdir of apps/ with a mix.exs is one unit.
      const out: Unit[] = [];
      const entries = await readdir(appsDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const appRoot = resolve(appsDir, e.name);
        if (!(await Bun.file(resolve(appRoot, "mix.exs")).exists())) continue;
        const relPath = `apps/${e.name}`;
        out.push({
          id: `unit:elixir:${relPath}`,
          kind: "elixir_app",
          name: e.name,
          path: relPath,
          metadata: {
            repo_root: repoRoot,
            source_dirs: ["lib", "test"],
            module_prefixes: [],
          },
        });
      }
      if (out.length > 0) return out;
    }
    if (await Bun.file(resolve(repoRoot, "mix.exs")).exists()) {
      return [
        {
          id: "unit:elixir:.",
          kind: "elixir_app",
          name: basename(repoRoot),
          path: ".",
          metadata: { repo_root: repoRoot, source_dirs: ["lib", "test"] },
        },
      ];
    }
    if (await hasAnyEx(repoRoot)) {
      return [
        {
          id: "unit:elixir:.",
          kind: "elixir_app",
          name: basename(repoRoot),
          path: ".",
          metadata: { repo_root: repoRoot, source_dirs: ["lib"] },
        },
      ];
    }
    return [];
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
    const exFiles: Array<{ relPath: string; unitId: string; module: string | null }> = [];

    // Pass 1: collect files + module names → unit map.
    const moduleToUnit = new Map<string, string>();
    for (const u of units) {
      const sourceDirs = (u.metadata?.["source_dirs"] as string[] | undefined) ?? ["lib"];
      for (const sd of sourceDirs) {
        const absDir = resolve(repoRoot, u.path === "." ? sd : `${u.path}/${sd}`);
        if (!(await dirExists(absDir))) continue;
        const collected = await collectFiles(absDir, EX_EXT, repoRoot);
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
          const text = await safeRead(absPath);
          const mods = text === null ? [] : parseModuleDeclarations(text);
          for (const m of mods) moduleToUnit.set(m, u.id);
          exFiles.push({
            relPath,
            unitId: u.id,
            module: mods[0] ?? null,
          });
        }
      }
    }

    // Pass 2: alias / import / use → cross-module refs → unit deps.
    const deps: Dep[] = [];
    const seenDep = new Set<string>();
    for (const { relPath, unitId } of exFiles) {
      const text = await safeRead(resolve(repoRoot, relPath));
      if (text === null) continue;
      for (const referenced of parseModuleReferences(text)) {
        const owner = moduleToUnit.get(referenced);
        if (!owner || owner === unitId) continue;
        const key = `${unitId}->${owner}`;
        if (seenDep.has(key)) continue;
        seenDep.add(key);
        deps.push({ from_unit_id: unitId, to_unit_id: owner, kind: "alias" });
      }
    }

    let symbols: Symbol[] = [];
    let refs: Ref[] = [];
    let typeRelations: TypeRelation[] = [];
    let callEdges: CallEdge[] = [];

    const lsp = await this.indexWithElixirLs(
      repoRoot,
      exFiles.map(({ relPath, unitId }) => ({ relPath, unitId })),
      new Set(units.map((u) => u.id)),
    );
    // We prefer LSP results when they are non-empty. Falling back to the
    // parser when LSP returns nothing usable handles two real-world cases:
    // (1) elixir-ls is installed but the project has not been compiled yet,
    // so documentSymbol responds with []; (2) the LSP process crashed and
    // got swallowed by `indexWithElixirLs`'s `catch`.
    if (lsp.ran && lsp.symbols.length > 0) {
      symbols = lsp.symbols;
      refs = lsp.refs;
      typeRelations = lsp.typeRelations;
      callEdges = lsp.callEdges;
    } else {
      for (const { relPath, unitId } of exFiles) {
        const text = await safeRead(resolve(repoRoot, relPath));
        if (text === null) continue;
        symbols.push(...parseTopLevelDefs(text, unitId, relPath));
      }
    }

    // Parser-based @behaviour / defimpl type_relations (always merged, even
    // when LSP runs, because elixir-ls does not surface type_relations).
    const seenSymId = new Set(symbols.map((s) => s.id));
    const seenRelKey = new Set(
      typeRelations.map((r) => `${r.from_type_id}::${r.to_type_id}::${r.kind}`),
    );
    for (const { relPath, unitId } of exFiles) {
      const text = await safeRead(resolve(repoRoot, relPath));
      if (text === null) continue;
      const parsed = parseBehaviourRelations(text, unitId, relPath);
      for (const sym of parsed.symbols) {
        if (!seenSymId.has(sym.id)) {
          symbols.push(sym);
          seenSymId.add(sym.id);
        }
      }
      for (const rel of parsed.typeRelations) {
        const key = `${rel.from_type_id}::${rel.to_type_id}::${rel.kind}`;
        if (!seenRelKey.has(key)) {
          typeRelations.push(rel);
          seenRelKey.add(key);
        }
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

  private async indexWithElixirLs(
    repoRoot: string,
    exFiles: Array<{ relPath: string; unitId: string }>,
    unitIds: Set<string>,
  ): Promise<{
    ran: boolean;
    symbols: Symbol[];
    refs: Ref[];
    typeRelations: TypeRelation[];
    callEdges: CallEdge[];
  }> {
    const empty = { symbols: [], refs: [], typeRelations: [], callEdges: [] };
    if (exFiles.length === 0) return { ran: false, ...empty };

    const launcher =
      (await whichTool("elixir-ls")) ? "elixir-ls"
      : (await whichTool("language_server.sh")) ? "language_server.sh"
      : null;
    if (!this.externalClient && launcher === null) {
      return { ran: false, ...empty };
    }

    const client =
      this.externalClient ?? new LspClient([launcher!], repoRoot);
    const ownClient = this.externalClient === null;
    try {
      return {
        ran: true,
        ...(await runElixirLsIndexing(repoRoot, exFiles, unitIds, client)),
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
    diagnostics.push(...detectCyclicDeps(deps, "unit:elixir:"));

    if (await whichTool("mix")) {
      // Try credo via mix.
      const r = await exec(["mix", "credo", "--format=json"], { cwd: repoRoot });
      if (r.stdout.trim().startsWith("{") || r.stdout.trim().startsWith("[")) {
        diagnostics.push(...parseCredoJson(r.stdout, repoRoot));
      }
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

async function hasAnyEx(root: string): Promise<boolean> {
  async function walk(dir: string, depth: number): Promise<boolean> {
    if (depth > 3) return false;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "_build" || e.name === "deps") continue;
      if (e.isDirectory()) {
        if (await walk(resolve(dir, e.name), depth + 1)) return true;
      } else if (e.name.endsWith(".ex") || e.name.endsWith(".exs")) {
        return true;
      }
    }
    return false;
  }
  return walk(root, 0);
}

const MODULE_RE = /\bdefmodule\s+([A-Z][\w.]*)/g;

/** Extract every `defmodule X.Y.Z do` name appearing in a file. */
export function parseModuleDeclarations(text: string): string[] {
  const out: string[] = [];
  MODULE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MODULE_RE.exec(text)) !== null) out.push(m[1]!);
  return out;
}

const ALIAS_RE =
  /\b(?:alias|import|use|require)\s+([A-Z][\w.]*?)(?:\.\{([^}]*)\})?(?=\s|[,;)\n]|$)/g;

/**
 * Extract module references introduced by `alias` / `import` / `use` /
 * `require`. Handles the multi-form `alias Foo.{Bar, Baz}` by expanding
 * to `Foo.Bar` / `Foo.Baz`. Trailing-dot artifacts (e.g. capturing `Foo.`
 * when followed by `{...}`) are normalized away.
 */
export function parseModuleReferences(text: string): string[] {
  const out = new Set<string>();
  ALIAS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ALIAS_RE.exec(text)) !== null) {
    const root = m[1]!.replace(/\.$/, "");
    const braceBody = m[2];
    if (braceBody !== undefined) {
      for (const sub of braceBody.split(",")) {
        const name = sub.trim();
        if (!name) continue;
        out.add(`${root}.${name}`);
      }
    } else if (root) {
      out.add(root);
    }
  }
  return [...out];
}

const DEFS_RE = /\b(def|defp|defmacro|defmacrop)\s+([\w?!]+)/g;
const DEFMODULE_RE = /\bdefmodule\s+([A-Z][\w.]*)/g;

/** Convert a byte offset in `source` to a 1-based line/column position. */
function offsetToPosition(
  source: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < offset; i++) {
    if (source.charCodeAt(i) === 10) { line++; lastNl = i; }
  }
  return { line, column: offset - lastNl };
}

/** Fallback symbol scan: emit modules + def/defp declarations. */
export function parseTopLevelDefs(
  source: string,
  unitId: string,
  relPath: string,
): Symbol[] {
  const out: Symbol[] = [];
  const unitPath = unitId.replace(/^unit:elixir:/, "");

  function pushSym(name: string, kind: string, exported: boolean, offset: number) {
    const { line, column } = offsetToPosition(source, offset);
    const sigHash = hashSig(`${name}:${kind}:${line}`);
    out.push({
      id: `sym:elixir:${unitPath}#${kind}#${name}#sig:${sigHash}`,
      unit_id: unitId,
      name,
      kind,
      exported,
      decl: {
        file_id: `file:${relPath}`,
        position: { line, column },
      },
    });
  }

  DEFMODULE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEFMODULE_RE.exec(source)) !== null) {
    pushSym(m[1]!, "module", true, m.index);
  }

  DEFS_RE.lastIndex = 0;
  while ((m = DEFS_RE.exec(source)) !== null) {
    const kw = m[1]!;
    const name = m[2]!;
    const exported = kw === "def" || kw === "defmacro";
    pushSym(name, kw === "defmacro" || kw === "defmacrop" ? "macro" : "function", exported, m.index);
  }
  return out;
}

// --- behaviour / protocol relations (parser-based) ---

const BEHAVIOUR_RE = /@behaviour\s+([A-Z][\w.]*)/g;
const DEFIMPL_RE = /\bdefimpl\s+([A-Z][\w.]*)\s*,\s*for:\s*([A-Z][\w.]*)/g;

/**
 * Parse `@behaviour` attributes and `defimpl` blocks to produce TypeRelations.
 *
 * - `@behaviour Foo` inside `defmodule M` → TypeRelation {from: M, to: Foo, kind: "implements"}
 * - `defimpl Proto, for: Type` → TypeRelation {from: Type, to: Proto, kind: "implements"}
 *
 * Also emits Symbol entries for each defmodule (kind: "module") so callers can
 * deduplicate against LSP-emitted symbols by name.
 */
export function parseBehaviourRelations(
  source: string,
  unitId: string,
  relPath: string,
): { symbols: Symbol[]; typeRelations: TypeRelation[] } {
  const symbols: Symbol[] = [];
  const typeRelations: TypeRelation[] = [];
  const unitPath = unitId.replace(/^unit:elixir:/, "");

  // Collect all defmodule positions and names, with their byte offsets so we
  // can attribute @behaviour annotations to the enclosing module.
  const moduleInfos: Array<{ name: string; offset: number; id: string }> = [];
  DEFMODULE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEFMODULE_RE.exec(source)) !== null) {
    const name = m[1]!;
    const pos = offsetToPosition(source, m.index);
    const sigHash = hashSig(`${name}:module:${pos.line}`);
    const id = `sym:elixir:${unitPath}#module#${name}#sig:${sigHash}`;
    symbols.push({
      id,
      unit_id: unitId,
      name,
      kind: "module",
      exported: true,
      decl: { file_id: `file:${relPath}`, position: pos },
    });
    moduleInfos.push({ name, offset: m.index, id });
  }

  /** Return the innermost defmodule that encloses `offset`. */
  function enclosingModule(offset: number): { name: string; id: string } | null {
    // The nearest defmodule whose position is before `offset`.
    let best: { name: string; offset: number; id: string } | null = null;
    for (const mi of moduleInfos) {
      if (mi.offset < offset && (best === null || mi.offset > best.offset)) {
        best = mi;
      }
    }
    return best;
  }

  // @behaviour Module  →  enclosing defmodule implements Module
  BEHAVIOUR_RE.lastIndex = 0;
  while ((m = BEHAVIOUR_RE.exec(source)) !== null) {
    const behaviourName = m[1]!;
    const enc = enclosingModule(m.index);
    if (!enc) continue;
    // behaviourName is typically an external module (e.g. GenServer) or a
    // local one. We emit the relation with to_type_id as a bare name-based id
    // so reviewers can correlate; full resolution would require cross-file data.
    typeRelations.push({
      from_type_id: enc.id,
      to_type_id: `sym:elixir:${unitPath}#module#${behaviourName}`,
      kind: "implements",
    });
  }

  // defimpl Protocol, for: Type  →  Type implements Protocol
  DEFIMPL_RE.lastIndex = 0;
  while ((m = DEFIMPL_RE.exec(source)) !== null) {
    const protoName = m[1]!;
    const typeName = m[2]!;
    const pos = offsetToPosition(source, m.index);
    const sigHash = hashSig(`${typeName}:class:${pos.line}`);
    const typeId = `sym:elixir:${unitPath}#class#${typeName}#sig:${sigHash}`;
    // Emit a class symbol for the implementing type if not already captured.
    if (!symbols.some((s) => s.name === typeName && s.kind === "class")) {
      symbols.push({
        id: typeId,
        unit_id: unitId,
        name: typeName,
        kind: "class",
        exported: true,
        decl: { file_id: `file:${relPath}`, position: pos },
      });
    }
    // Locate the protocol symbol id (may have been emitted from defmodule or
    // from a previous iteration); fall back to a stable name-based id.
    const protoSym = symbols.find((s) => s.name === protoName && s.kind === "module");
    const protoId = protoSym?.id ?? `sym:elixir:${unitPath}#module#${protoName}`;
    typeRelations.push({
      from_type_id: typeId,
      to_type_id: protoId,
      kind: "implements",
    });
  }

  return { symbols, typeRelations };
}

async function runElixirLsIndexing(
  repoRoot: string,
  exFiles: Array<{ relPath: string; unitId: string }>,
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

  for (const { relPath } of exFiles) {
    try { await client.openDocument(relPath, "elixir"); }
    catch { /* ignore */ }
  }

  // elixir-ls compiles the project on startup; probe before main pass.
  const probe = exFiles[0]?.relPath;
  if (probe) {
    const start = Date.now();
    while (Date.now() - start < 120_000) {
      try {
        const res = await client.documentSymbols(probe, 5_000);
        if (res.length > 0) break;
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }

  for (const { relPath, unitId } of exFiles) {
    let lspSyms: LspDocumentSymbol[];
    try { lspSyms = await client.documentSymbols(relPath); } catch { continue; }
    for (const lspSym of flattenSymbols(lspSyms)) {
      const kind = ELIXIR_SYMBOL_KIND_MAP[lspSym.kind];
      if (!kind) continue;
      const line = lspSym.selectionRange.start.line;
      const col = lspSym.selectionRange.start.character;
      const sym = lspSymbolToExSymbol(lspSym, kind, relPath, unitId);
      symbols.push(sym);
      symbolByPos.set(`${relPath}:${line}:${col}`, sym);
      if (kind === "function") {
        funcSymbols.push({ symbol: sym, relPath, line, col });
        refTargets.push({ symbol: sym, relPath, line, col });
      }
      if (kind === "module" || kind === "namespace" || kind === "struct") {
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
      const kind =
        targetSym.kind === "module" || targetSym.kind === "namespace" || targetSym.kind === "struct"
          ? "type_ref"
          : "reference";
      refs.push({
        from_symbol_id: fromSymbol?.id ?? `file_scope:${locRelPath}`,
        to_symbol_id: targetSym.id,
        site: {
          file_id: fileId,
          position: { line: locLine, column: locCol },
        },
        kind,
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

function lspSymbolToExSymbol(
  lspSym: LspDocumentSymbol,
  kind: string,
  relPath: string,
  unitId: string,
): Symbol {
  const line = lspSym.selectionRange.start.line;
  const col = lspSym.selectionRange.start.character;
  const unitPath = unitId.replace(/^unit:elixir:/, "");
  const sigHash = hashSig(`${lspSym.name}:${lspSym.kind}:${line}`);
  return {
    id: `sym:elixir:${unitPath}#${kind}#${lspSym.name}#sig:${sigHash}`,
    unit_id: unitId,
    name: lspSym.name,
    kind,
    // elixir-ls doesn't expose def vs defp through documentSymbol; default true.
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
      (s) => s.decl.file_id === fileId && (s.kind === "function" || s.kind === "macro"),
    )
    .sort((a, b) => a.decl.position.line - b.decl.position.line);
  for (let i = 0; i < fns.length; i++) {
    const sym = fns[i]!;
    const next = i + 1 < fns.length ? fns[i + 1]!.decl.position.line : Infinity;
    if (sym.decl.position.line <= line && line < next) return sym;
  }
  return null;
}

interface CredoIssue {
  filename?: string;
  line_no?: number;
  column?: number;
  priority?: number;
  category?: string;
  check?: string;
  message?: string;
}

export function parseCredoJson(stdout: string, repoRoot: string): Diagnostic[] {
  if (!stdout.trim()) return [];
  let payload: { issues?: CredoIssue[] };
  try {
    payload = JSON.parse(stdout);
  } catch {
    return [];
  }
  const out: Diagnostic[] = [];
  for (const i of payload.issues ?? []) {
    if (!i.filename || !i.line_no) continue;
    const rel = relative(repoRoot, resolve(repoRoot, i.filename));
    if (rel.startsWith("..")) continue;
    const severity: Diagnostic["severity"] =
      (i.priority ?? 0) >= 10 ? "error"
      : (i.priority ?? 0) >= 5 ? "warning"
      : "info";
    out.push({
      file_id: `file:${rel}`,
      position: { line: i.line_no, column: i.column ?? 1 },
      severity,
      message: `${i.check ?? i.category ?? "credo"}: ${i.message ?? ""}`,
      tool: "credo",
    });
  }
  return out;
}

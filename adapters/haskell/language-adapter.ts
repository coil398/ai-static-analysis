// HaskellLanguageAdapter — HASKELL_SPEC.md
//
// Strategy:
//   - detect: *.cabal, stack.yaml, cabal.project, package.yaml
//   - enumerateUnits: each Cabal stanza (library / executable / test-suite /
//     benchmark) becomes one unit. hs-source-dirs gives us the source root.
//     A bare *.cabal with no parseable stanzas falls back to "unit:haskell:."
//   - indexUnits: collect .hs/.lhs files under each unit's hs-source-dirs,
//     parse `import` declarations for module-level deps, and drive HLS for
//     LSP-backed symbols / refs / call_edges / type_relations.
//   - diagnose: hlint when available.

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

const HS_SOURCE_EXT = [".hs", ".lhs"];

// HLS reports a fairly rich SymbolKind surface; map the ones Haskell actually
// emits onto adapter-internal kinds.
const HASKELL_SYMBOL_KIND_MAP: Record<number, string> = {
  2: "module",
  5: "class",
  11: "interface",  // type class
  10: "enum",
  12: "function",
  13: "variable",
  14: "constant",
  22: "type",
  23: "type",
};

interface CabalStanza {
  /** `library` | `executable <name>` | `test-suite <name>` | `benchmark <name>` */
  kind: "library" | "executable" | "test-suite" | "benchmark";
  name: string;
  hsSourceDirs: string[];
  buildDepends: string[];
}

export class HaskellLanguageAdapter implements LanguageAdapter {
  readonly lang = "haskell";

  private externalClient: LspClient | null = null;
  setExternalLspClient(client: LspClient | null): void {
    this.externalClient = client;
  }

  async detect(repoRoot: string): Promise<DetectResult> {
    const high = ["cabal.project", "stack.yaml", "package.yaml"];
    for (const m of high) {
      if (await Bun.file(resolve(repoRoot, m)).exists()) {
        return { supported: true, confidence: 1.0 };
      }
    }
    // Any *.cabal at root → supported.
    try {
      const entries = await readdir(repoRoot);
      if (entries.some((e) => e.endsWith(".cabal"))) {
        return { supported: true, confidence: 1.0 };
      }
      if (entries.some((e) => e.endsWith(".hs"))) {
        return { supported: true, confidence: 0.5 };
      }
    } catch { /* ignore */ }
    return { supported: false, confidence: 0 };
  }

  async doctor(): Promise<DoctorResult> {
    const missing: string[] = [];
    const notes: string[] = [];

    const ghc = await whichTool("ghc");
    if (!ghc) missing.push("ghc");
    else {
      const v = await exec(["ghc", "--version"]);
      if (v.exitCode === 0) notes.push(v.stdout);
    }

    const optional = [
      { name: "cabal", purpose: "build / test driver" },
      { name: "stack", purpose: "alternative build / test driver" },
      { name: "haskell-language-server-wrapper", purpose: "symbols/refs/call_edges/type_relations (LSP)" },
      { name: "haskell-language-server", purpose: "LSP fallback if the wrapper is absent" },
      { name: "hlint", purpose: "static analysis (diagnose)" },
      { name: "ormolu", purpose: "formatter" },
      { name: "fourmolu", purpose: "formatter (alternative)" },
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
        "Haskell toolchain install paths vary by OS. Suggested commands:",
        "  - ghcup: `curl --proto =https --tlsv1.2 -sSf https://get-ghcup.haskell.org | sh`",
        "  - then: `ghcup install ghc recommended && ghcup install hls recommended && ghcup install cabal recommended`",
        "  - hlint: `cabal install hlint` (or via ghcup)",
      ],
    };
  }

  async enumerateUnits(
    repoRoot: string,
    _profile: Record<string, string>,
  ): Promise<Unit[]> {
    const cabalFile = await findCabalFile(repoRoot);
    if (!cabalFile) {
      // Fallback: any .hs under the tree → single root unit.
      if (await hasAnyHs(repoRoot)) {
        return [
          {
            id: "unit:haskell:.",
            kind: "haskell_package",
            name: basename(repoRoot),
            path: ".",
            metadata: { repo_root: repoRoot, stanza: "auto", hs_source_dirs: ["."] },
          },
        ];
      }
      return [];
    }
    const text = await safeRead(cabalFile);
    if (text === null) return [];
    const stanzas = parseCabalStanzas(text);
    if (stanzas.length === 0) {
      return [
        {
          id: "unit:haskell:.",
          kind: "haskell_package",
          name: basename(cabalFile).replace(/\.cabal$/, ""),
          path: ".",
          metadata: { repo_root: repoRoot, stanza: "library", hs_source_dirs: ["src"] },
        },
      ];
    }
    return stanzas.map((s) => ({
      id: `unit:haskell:${s.kind}:${s.name}`,
      kind: `haskell_${s.kind.replace("-", "_")}`,
      name: s.name,
      // Use the first hs-source-dir as the canonical path; the full list is
      // preserved in metadata for the indexer.
      path: s.hsSourceDirs[0] ?? ".",
      metadata: {
        repo_root: repoRoot,
        stanza: s.kind,
        hs_source_dirs: s.hsSourceDirs,
        build_depends: s.buildDepends,
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

    // Pre-compute: which units exist by build-depends name (so we can resolve
    // cross-stanza deps inside the same cabal package), plus which modules
    // live in each unit (so import-based deps can resolve module → unit).
    const unitByName = new Map<string, string>();
    for (const u of units) unitByName.set(u.name, u.id);

    const files: File[] = [];
    const deps: Dep[] = [];
    const seenDep = new Set<string>();
    const hsFiles: Array<{ relPath: string; unitId: string; moduleName: string }> = [];

    // Pass 1: collect files + module names per unit.
    const moduleToUnit = new Map<string, string>();
    for (const u of units) {
      const sourceDirs = (u.metadata?.["hs_source_dirs"] as string[] | undefined) ?? ["."];
      for (const srcDir of sourceDirs) {
        const absDir = resolve(repoRoot, srcDir);
        if (!(await dirExists(absDir))) continue;
        const collected = await collectFiles(absDir, HS_SOURCE_EXT, repoRoot);
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
          const moduleName = inferModuleName(relPath, srcDir);
          if (moduleName) {
            moduleToUnit.set(moduleName, u.id);
            hsFiles.push({ relPath, unitId: u.id, moduleName });
          }
        }
      }
    }

    // Pass 2: parse imports → deps (module-level resolution).
    for (const { relPath, unitId } of hsFiles) {
      const text = await safeRead(resolve(repoRoot, relPath));
      if (text === null) continue;
      for (const imported of parseImports(text)) {
        const owner = moduleToUnit.get(imported);
        if (!owner || owner === unitId) continue;
        const key = `${unitId}->${owner}`;
        if (seenDep.has(key)) continue;
        seenDep.add(key);
        deps.push({
          from_unit_id: unitId,
          to_unit_id: owner,
          kind: "import",
        });
      }
    }

    // Build-depends-derived deps (cross-stanza, e.g. executable depends on
    // its library). Only emits when both endpoints are in our unit set.
    for (const u of units) {
      const buildDeps = (u.metadata?.["build_depends"] as string[] | undefined) ?? [];
      for (const dep of buildDeps) {
        const owner = unitByName.get(dep);
        if (!owner || owner === u.id) continue;
        const key = `${u.id}->${owner}`;
        if (seenDep.has(key)) continue;
        seenDep.add(key);
        deps.push({ from_unit_id: u.id, to_unit_id: owner, kind: "build-depends" });
      }
    }

    let symbols: Symbol[] = [];
    let refs: Ref[] = [];
    let typeRelations: TypeRelation[] = [];
    let callEdges: CallEdge[] = [];

    const lsp = await this.indexWithHls(
      repoRoot,
      hsFiles.map(({ relPath, unitId }) => ({ relPath, unitId })),
      new Set(units.map((u) => u.id)),
    );
    // Prefer LSP when it returns non-empty; otherwise fall back to the
    // parser. HLS may return [] when (a) it's not installed and our
    // `whichTool` saw a stale symlink, (b) the project hasn't been built
    // yet, or (c) the HLS GHC version doesn't match the project's GHC.
    if (lsp.ran && lsp.symbols.length > 0) {
      symbols = lsp.symbols;
      refs = lsp.refs;
      typeRelations = lsp.typeRelations;
      callEdges = lsp.callEdges;
    } else {
      for (const { relPath, unitId } of hsFiles) {
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

  private async indexWithHls(
    repoRoot: string,
    hsFiles: Array<{ relPath: string; unitId: string }>,
    unitIds: Set<string>,
  ): Promise<{
    ran: boolean;
    symbols: Symbol[];
    refs: Ref[];
    typeRelations: TypeRelation[];
    callEdges: CallEdge[];
  }> {
    const empty = { symbols: [], refs: [], typeRelations: [], callEdges: [] };
    if (hsFiles.length === 0) return { ran: false, ...empty };

    const wrapper = (await whichTool("haskell-language-server-wrapper"))
      ? "haskell-language-server-wrapper"
      : (await whichTool("haskell-language-server"))
        ? "haskell-language-server"
        : null;
    if (!this.externalClient && wrapper === null) {
      return { ran: false, ...empty };
    }

    const client =
      this.externalClient ??
      new LspClient([wrapper!, "--lsp"], repoRoot);
    const ownClient = this.externalClient === null;
    try {
      return {
        ran: true,
        ...(await runHlsIndexing(repoRoot, hsFiles, unitIds, client)),
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
    diagnostics.push(...detectCyclicDeps(deps, "unit:haskell:"));

    if (await whichTool("hlint")) {
      const r = await exec(["hlint", "--json", "."], { cwd: repoRoot });
      diagnostics.push(...parseHlintJson(r.stdout, repoRoot));
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

async function findCabalFile(repoRoot: string): Promise<string | null> {
  try {
    const entries = await readdir(repoRoot);
    const cabal = entries.find((e) => e.endsWith(".cabal"));
    if (cabal) return resolve(repoRoot, cabal);
  } catch { /* ignore */ }
  return null;
}

async function hasAnyHs(repoRoot: string): Promise<boolean> {
  async function walk(dir: string, depth: number): Promise<boolean> {
    if (depth > 3) return false;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "dist" || e.name === "dist-newstyle") continue;
      if (e.isDirectory()) {
        if (await walk(resolve(dir, e.name), depth + 1)) return true;
      } else if (e.name.endsWith(".hs") || e.name.endsWith(".lhs")) {
        return true;
      }
    }
    return false;
  }
  return walk(repoRoot, 0);
}

/**
 * Minimal cabal-file parser — just enough to recover the stanza header and
 * the `hs-source-dirs:` / `build-depends:` fields each one declares. The
 * full cabal grammar is not implemented; we tolerate comments, blank lines,
 * comma-separated build-depends, and `,`-prefixed continuation.
 */
export function parseCabalStanzas(text: string): CabalStanza[] {
  const lines = text.split(/\r?\n/);
  const stanzas: CabalStanza[] = [];
  let current: CabalStanza | null = null;
  let currentField: "hs-source-dirs" | "build-depends" | null = null;

  const stanzaHeaderRe =
    /^(library|executable|test-suite|benchmark)(?:\s+([\w-]+))?\s*$/i;
  const fieldRe = /^(\s*)([\w-]+)\s*:\s*(.*)$/;

  for (const rawLine of lines) {
    const line = rawLine.replace(/--.*$/, "");
    if (!line.trim()) continue;

    const header = stanzaHeaderRe.exec(line);
    if (header && /^\S/.test(line)) {
      // Close out previous stanza.
      if (current) stanzas.push(current);
      const kind = header[1]!.toLowerCase() as CabalStanza["kind"];
      const name = header[2] ?? (kind === "library" ? "library" : kind);
      current = { kind, name, hsSourceDirs: [], buildDepends: [] };
      currentField = null;
      continue;
    }
    if (!current) continue;

    const fieldMatch = fieldRe.exec(line);
    if (fieldMatch) {
      const field = fieldMatch[2]!.toLowerCase();
      const value = fieldMatch[3]!.trim();
      if (field === "hs-source-dirs") {
        currentField = "hs-source-dirs";
        for (const v of value.split(/\s+|,/).filter(Boolean)) current.hsSourceDirs.push(v);
        continue;
      }
      if (field === "build-depends") {
        currentField = "build-depends";
        for (const v of splitBuildDepends(value)) current.buildDepends.push(v);
        continue;
      }
      currentField = null;
      continue;
    }

    // Continuation line (indented value).
    const continuation = line.replace(/^\s*,?\s*/, "");
    if (!continuation) continue;
    if (currentField === "hs-source-dirs") {
      for (const v of continuation.split(/\s+|,/).filter(Boolean)) current.hsSourceDirs.push(v);
    } else if (currentField === "build-depends") {
      for (const v of splitBuildDepends(continuation)) current.buildDepends.push(v);
    }
  }
  if (current) stanzas.push(current);

  // Default hs-source-dirs: library → "." or "src"; everything else → "."
  for (const s of stanzas) {
    if (s.hsSourceDirs.length === 0) {
      s.hsSourceDirs = s.kind === "library" ? ["src"] : ["."];
    }
  }
  return stanzas;
}

function splitBuildDepends(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.split(/\s+/)[0]!);
}

/** `src/Lib/Greet.hs` (under hs-source-dirs `src`) → `Lib.Greet`. */
export function inferModuleName(relPath: string, hsSourceDir: string): string | null {
  const norm = relPath.replace(/\\/g, "/");
  const dirNorm = hsSourceDir.replace(/^\.\//, "").replace(/\/$/, "");
  const prefix = dirNorm === "." || dirNorm === "" ? "" : `${dirNorm}/`;
  if (prefix && !norm.startsWith(prefix)) return null;
  const inner = prefix ? norm.slice(prefix.length) : norm;
  if (!inner.endsWith(".hs") && !inner.endsWith(".lhs")) return null;
  const stem = inner.replace(/\.l?hs$/, "");
  const parts = stem.split("/");
  if (parts.some((p) => !/^[A-Z][\w']*$/.test(p))) return null;
  return parts.join(".");
}

const IMPORT_RE =
  /^\s*import\s+(?:qualified\s+)?([A-Z][\w.']*)(?:\s+as\s+[A-Z][\w.']*)?(?:\s+(?:hiding\s+)?\([^)]*\))?/gm;

export function parseImports(source: string): string[] {
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    out.push(m[1]!);
  }
  return out;
}

// Top-level declarations. Two anchored regexes to avoid runaway matches
// across newlines (an earlier version used `[^=]*` which gobbled everything
// up to the next `=` in the file):
//   - HS_TYPE_SIG_RE matches `foo :: Type`
//   - HS_FN_BINDING_RE matches `foo x y = body` (single line up to `=`)
//   - HS_TYPE_DECL_RE matches `data|newtype|type|class Foo ...`
const HS_TYPE_SIG_RE = /^([a-z_][\w']*)\s*::/gm;
const HS_FN_BINDING_RE = /^([a-z_][\w']*)(?:[ \t]+[^\n=]*)?[ \t]*=(?!=)/gm;
const HS_TYPE_DECL_RE = /^(data|newtype|type|class)[ \t]+([A-Z][\w']*)/gm;

/**
 * Fallback symbol scan when HLS is unavailable or returns nothing useful.
 * Emits one Symbol per top-level binding / data / newtype / type / class.
 * Multiple sightings of the same function (type signature + body) collapse
 * to a single symbol by `(name, line)`.
 */
export function parseTopLevelDefs(
  source: string,
  unitId: string,
  relPath: string,
): Symbol[] {
  const out: Symbol[] = [];
  const seen = new Set<string>();
  const unitPath = unitId.replace(/^unit:haskell:/, "");

  function emit(name: string, kind: string, offset: number) {
    let line = 1;
    let lastNl = -1;
    for (let i = 0; i < offset; i++) {
      if (source.charCodeAt(i) === 10) {
        line++;
        lastNl = i;
      }
    }
    const key = `${name}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    const column = offset - lastNl;
    const sigHash = hashSig(`${name}:${kind}:${line}`);
    out.push({
      id: `sym:haskell:${unitPath}#${kind}#${name}#sig:${sigHash}`,
      unit_id: unitId,
      name,
      kind,
      // Without parsing the module header export list we can't tell what is
      // exported — be conservative and mark everything as exported.
      exported: true,
      decl: {
        file_id: `file:${relPath}`,
        position: { line, column },
      },
    });
  }

  const skipKeywords = new Set(["module", "import", "where", "let", "in", "do"]);

  for (const re of [HS_TYPE_SIG_RE, HS_FN_BINDING_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const name = m[1]!;
      if (skipKeywords.has(name)) continue;
      emit(name, "function", m.index);
    }
  }
  HS_TYPE_DECL_RE.lastIndex = 0;
  let mt: RegExpExecArray | null;
  while ((mt = HS_TYPE_DECL_RE.exec(source)) !== null) {
    const kw = mt[1]!;
    const name = mt[2]!;
    const kind = kw === "class" ? "class" : "type";
    emit(name, kind, mt.index);
  }
  return out;
}

async function runHlsIndexing(
  repoRoot: string,
  hsFiles: Array<{ relPath: string; unitId: string }>,
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
  const refTargetSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];
  const typeSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];

  for (const { relPath } of hsFiles) {
    try { await client.openDocument(relPath, "haskell"); }
    catch { /* ignore */ }
  }

  // HLS compiles the whole project before symbols become available — probe.
  const probe = hsFiles[0]?.relPath;
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

  for (const { relPath, unitId } of hsFiles) {
    let lspSyms: LspDocumentSymbol[];
    try { lspSyms = await client.documentSymbols(relPath); } catch { continue; }
    for (const lspSym of flattenSymbols(lspSyms)) {
      const kind = HASKELL_SYMBOL_KIND_MAP[lspSym.kind];
      if (!kind) continue;
      const line = lspSym.selectionRange.start.line;
      const col = lspSym.selectionRange.start.character;
      const sym = lspSymbolToHsSymbol(lspSym, kind, relPath, unitId);
      symbols.push(sym);
      symbolByPos.set(`${relPath}:${line}:${col}`, sym);
      if (kind === "function" || kind === "method") {
        funcSymbols.push({ symbol: sym, relPath, line, col });
      }
      if (kind === "class" || kind === "interface" || kind === "type") {
        typeSymbols.push({ symbol: sym, relPath, line, col });
        refTargetSymbols.push({ symbol: sym, relPath, line, col });
      }
      if (kind === "variable" || kind === "constant" || kind === "function") {
        refTargetSymbols.push({ symbol: sym, relPath, line, col });
      }
    }
  }

  // Call edges: HLS' prepareCallHierarchy support landed in recent versions —
  // gracefully handle servers that don't implement it.
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
            dispatch: "static",
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

  // Refs (non-call).
  const callRefKeys = new Set(
    refs.map((r) => `${r.to_symbol_id}@${r.site.file_id}:${r.site.position.line}:${r.site.position.column}`),
  );
  for (const { symbol: targetSym, relPath: tRelPath, line: tLine, col: tCol } of refTargetSymbols) {
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
        targetSym.kind === "class" || targetSym.kind === "interface" || targetSym.kind === "type"
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

  // type_relations: typeclass instance via textDocument/implementation.
  for (const { symbol, relPath, line, col } of typeSymbols) {
    let impls;
    try { impls = await client.implementation(relPath, line, col); }
    catch { continue; }
    for (const impl of impls) {
      const implRelPath = relative(repoRoot, LspClient.uriToPath(impl.uri));
      const implSym = symbolByPos.get(
        `${implRelPath}:${impl.range.start.line}:${impl.range.start.character}`,
      );
      if (!implSym) continue;
      typeRelations.push({
        from_type_id: implSym.id,
        to_type_id: symbol.id,
        kind: "implements",
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

function lspSymbolToHsSymbol(
  lspSym: LspDocumentSymbol,
  kind: string,
  relPath: string,
  unitId: string,
): Symbol {
  const line = lspSym.selectionRange.start.line;
  const col = lspSym.selectionRange.start.character;
  const unitPath = unitId.replace(/^unit:haskell:/, "");
  const sigHash = hashSig(`${lspSym.name}:${lspSym.kind}:${line}`);
  return {
    id: `sym:haskell:${unitPath}#${kind}#${lspSym.name}#sig:${sigHash}`,
    unit_id: unitId,
    name: lspSym.name,
    kind,
    // Haskell exports are declared via the module header (`module M (a, b)
    // where`). HLS does not surface the export list per symbol, so default
    // to true.
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
      (s) =>
        s.decl.file_id === fileId &&
        (s.kind === "function" || s.kind === "method"),
    )
    .sort((a, b) => a.decl.position.line - b.decl.position.line);
  for (let i = 0; i < fns.length; i++) {
    const sym = fns[i]!;
    const next = i + 1 < fns.length ? fns[i + 1]!.decl.position.line : Infinity;
    if (sym.decl.position.line <= line && line < next) return sym;
  }
  return null;
}

interface HlintEntry {
  module?: string[];
  file?: string;
  startLine?: number;
  startColumn?: number;
  severity?: string;
  hint?: string;
  from?: string;
  to?: string;
}

export function parseHlintJson(stdout: string, repoRoot: string): Diagnostic[] {
  if (!stdout.trim()) return [];
  let entries: HlintEntry[];
  try {
    entries = JSON.parse(stdout) as HlintEntry[];
  } catch {
    return [];
  }
  const out: Diagnostic[] = [];
  for (const e of entries) {
    if (!e.file || !e.startLine) continue;
    const rel = relative(repoRoot, resolve(repoRoot, e.file));
    if (rel.startsWith("..")) continue;
    const severity: Diagnostic["severity"] =
      (e.severity ?? "").toLowerCase() === "error"
        ? "error"
        : (e.severity ?? "").toLowerCase() === "suggestion"
          ? "info"
          : "warning";
    out.push({
      file_id: `file:${rel}`,
      position: { line: e.startLine, column: e.startColumn ?? 1 },
      severity,
      message: e.hint ?? "hlint suggestion",
      tool: "hlint",
    });
  }
  return out;
}

// CppLanguageAdapter — CPP_SPEC.md
//
// Strategy:
//   - detect: CMakeLists.txt or compile_commands.json or Makefile + .cpp/.cc/.hpp/.h
//   - enumerateUnits: each top-level subdir containing .cpp/.cc/.cxx files
//     becomes one unit. Header-only directories that ship .hpp/.h are
//     collapsed into the unit that includes them (no separate "include" unit).
//     Single-source-dir projects collapse to unit:cpp:.
//   - indexUnits: collect sources + local headers, parse #include "..."
//     directives to compute deps between units, and run clangd (when
//     available) for symbols / refs / call_edges / type_relations.
//   - diagnose: clang-tidy / cppcheck when available.

import { basename, relative, resolve, dirname } from "node:path";
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

const CPP_SOURCE_EXT = [".cpp", ".cc", ".cxx", ".c++"];
const CPP_HEADER_EXT = [".hpp", ".hh", ".hxx", ".h++", ".h"];
const CPP_ALL_EXT = [...CPP_SOURCE_EXT, ...CPP_HEADER_EXT];

const CPP_SYMBOL_KIND_MAP: Record<number, string> = {
  5: "class",
  10: "enum",
  11: "interface",
  6: "method",
  9: "constructor",
  8: "field",
  12: "function",
  13: "variable",
  14: "constant",
  22: "struct",
  23: "struct",
};

export class CppLanguageAdapter implements LanguageAdapter {
  readonly lang = "cpp";

  private externalClient: LspClient | null = null;

  setExternalLspClient(client: LspClient | null): void {
    this.externalClient = client;
  }

  async detect(repoRoot: string): Promise<DetectResult> {
    const high = [
      "CMakeLists.txt",
      "compile_commands.json",
      "meson.build",
      "configure.ac",
    ];
    for (const m of high) {
      if (await Bun.file(resolve(repoRoot, m)).exists()) {
        return { supported: true, confidence: 1.0 };
      }
    }
    if (await Bun.file(resolve(repoRoot, "Makefile")).exists()) {
      // Makefile alone is ambiguous — only count if at least one C++ source
      // sits under the root.
      if (await hasAnySource(repoRoot, CPP_SOURCE_EXT)) {
        return { supported: true, confidence: 0.6 };
      }
    }
    if (await hasAnySource(repoRoot, CPP_SOURCE_EXT)) {
      return { supported: true, confidence: 0.4 };
    }
    return { supported: false, confidence: 0 };
  }

  async doctor(): Promise<DoctorResult> {
    const missing: string[] = [];
    const notes: string[] = [];

    const compilers = ["g++", "clang++", "c++"];
    let compiler: string | null = null;
    for (const c of compilers) {
      if (await whichTool(c)) {
        compiler = c;
        break;
      }
    }
    if (!compiler) {
      missing.push("c++ compiler");
    } else {
      const ver = await exec([compiler, "--version"]);
      const first = (ver.stdout || ver.stderr).split("\n")[0] ?? "";
      if (first) notes.push(first);
    }

    const optional: Array<{ name: string; purpose: string }> = [
      { name: "clangd", purpose: "symbols/refs/call_edges/type_relations (LSP)" },
      { name: "clang-tidy", purpose: "static analysis (diagnose)" },
      { name: "cppcheck", purpose: "static analysis (diagnose)" },
      { name: "clang-format", purpose: "formatter (run-actions)" },
      { name: "cmake", purpose: "build system (run-actions)" },
      { name: "ninja", purpose: "build driver (run-actions)" },
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
        "C++ tooling installation is platform-specific. Suggested commands:",
        "  - clangd / clang-tidy / clang-format: `apt install clangd clang-tidy clang-format` or `brew install llvm`",
        "  - cppcheck: `apt install cppcheck` or `brew install cppcheck`",
        "  - cmake: `apt install cmake` or `brew install cmake`",
      ],
    };
  }

  async enumerateUnits(
    repoRoot: string,
    _profile: Record<string, string>,
  ): Promise<Unit[]> {
    const subdirs = await topLevelSourceDirs(repoRoot);
    if (subdirs.length === 0) {
      // Single-directory project (sources sit directly at root)
      if (await hasAnySource(repoRoot, CPP_ALL_EXT)) {
        return [
          {
            id: "unit:cpp:.",
            kind: "cpp_module",
            name: basename(repoRoot),
            path: ".",
            metadata: { repo_root: repoRoot },
          },
        ];
      }
      return [];
    }
    return subdirs.map((relPath) => ({
      id: `unit:cpp:${relPath}`,
      kind: "cpp_module",
      name: basename(relPath),
      path: relPath,
      metadata: { repo_root: repoRoot },
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

    // Map header file paths → owning unit. A header is "owned" by the unit
    // it physically lives under; #include "<path>" against that path → dep.
    const headerOwnerByRelPath = new Map<string, string>();

    const files: File[] = [];
    const deps: Dep[] = [];
    const cppSourceFiles: Array<{ relPath: string; unitId: string }> = [];

    for (const unit of units) {
      const unitDir = resolve(repoRoot, unit.path);
      const collected = await collectFiles(unitDir, CPP_ALL_EXT, repoRoot);
      for (const relPath of collected) {
        const absPath = resolve(repoRoot, relPath);
        const [hash, generated] = await Promise.all([
          hashFile(absPath),
          isGenerated(absPath),
        ]);
        files.push({
          id: `file:${relPath}`,
          path: relPath,
          unit_id: unit.id,
          hash,
          generated,
        });
        if (!generated) {
          if (isHeader(relPath)) {
            headerOwnerByRelPath.set(relPath, unit.id);
          }
          if (isSource(relPath)) {
            cppSourceFiles.push({ relPath, unitId: unit.id });
          }
        }
      }
    }

    // Top-level headers (e.g. include/foo.hpp) that live outside any unit
    // are also indexed so #include resolution can find them. Their owning
    // unit is the source unit whose name (or source file basename) matches
    // the header — e.g. include/greet.hpp pairs with lib/greet.cpp → unit
    // is lib. Falls back to the first unit if no pairing is found.
    const looseHeaders = await findLooseHeaders(repoRoot, units);
    const sourceBasenamesByUnit = new Map<string, Set<string>>();
    for (const f of files) {
      if (!isSource(f.path)) continue;
      const stem = basename(f.path).replace(/\.[^.]+$/, "");
      const set = sourceBasenamesByUnit.get(f.unit_id);
      if (set) set.add(stem);
      else sourceBasenamesByUnit.set(f.unit_id, new Set([stem]));
    }
    for (const relPath of looseHeaders) {
      // Skip if we already saw it from a unit walk.
      if (files.some((f) => f.id === `file:${relPath}`)) continue;
      const absPath = resolve(repoRoot, relPath);
      const [hash, generated] = await Promise.all([
        hashFile(absPath),
        isGenerated(absPath),
      ]);
      const headerStem = basename(relPath).replace(/\.[^.]+$/, "");
      let owner = units[0]!.id;
      for (const [unitId, stems] of sourceBasenamesByUnit) {
        if (stems.has(headerStem)) {
          owner = unitId;
          break;
        }
      }
      files.push({
        id: `file:${relPath}`,
        path: relPath,
        unit_id: owner,
        hash,
        generated,
      });
    }

    // Build a lookup of header-base-name → file path so #include "foo.hpp"
    // can be resolved both as a direct relative path and as a basename match.
    const headerByBaseName = new Map<string, string[]>();
    for (const f of files) {
      if (!isHeader(f.path)) continue;
      const key = basename(f.path);
      const list = headerByBaseName.get(key);
      if (list) list.push(f.path);
      else headerByBaseName.set(key, [f.path]);
    }

    const seenDep = new Set<string>();
    for (const { relPath, unitId } of [
      ...cppSourceFiles,
      ...files
        .filter((f) => isHeader(f.path))
        .map((f) => ({ relPath: f.path, unitId: f.unit_id })),
    ]) {
      const absPath = resolve(repoRoot, relPath);
      const text = await safeRead(absPath);
      if (text === null) continue;

      for (const included of parseIncludes(text)) {
        // 1. Try direct relative resolution: <unit_dir>/<included>, or <repoRoot>/<included>
        const candidates = [
          relative(repoRoot, resolve(dirname(absPath), included)),
          included,
        ];
        let targetPath: string | null = null;
        for (const c of candidates) {
          if (files.some((f) => f.path === c)) {
            targetPath = c;
            break;
          }
        }
        // 2. Basename fallback
        if (!targetPath) {
          const cands = headerByBaseName.get(basename(included));
          if (cands && cands.length === 1) targetPath = cands[0]!;
        }
        if (!targetPath) continue;

        const owner = files.find((f) => f.path === targetPath)?.unit_id;
        if (!owner || owner === unitId) continue;
        const key = `${unitId}->${owner}`;
        if (seenDep.has(key)) continue;
        seenDep.add(key);
        deps.push({
          from_unit_id: unitId,
          to_unit_id: owner,
          kind: "include",
        });
      }
    }

    let symbols: Symbol[] = [];
    let refs: Ref[] = [];
    let typeRelations: TypeRelation[] = [];
    let callEdges: CallEdge[] = [];

    const lspResult = await this.indexWithClangd(
      repoRoot,
      files
        .filter((f) => !f.generated && (isSource(f.path) || isHeader(f.path)))
        .map((f) => ({ relPath: f.path, unitId: f.unit_id })),
      new Set(units.map((u) => u.id)),
    );
    if (lspResult.ran) {
      symbols = lspResult.symbols;
      refs = lspResult.refs;
      typeRelations = lspResult.typeRelations;
      callEdges = lspResult.callEdges;
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

  private async indexWithClangd(
    repoRoot: string,
    cppFiles: Array<{ relPath: string; unitId: string }>,
    unitIds: Set<string>,
  ): Promise<{
    ran: boolean;
    symbols: Symbol[];
    refs: Ref[];
    typeRelations: TypeRelation[];
    callEdges: CallEdge[];
  }> {
    const empty = { symbols: [], refs: [], typeRelations: [], callEdges: [] };
    if (cppFiles.length === 0) return { ran: false, ...empty };
    if (!this.externalClient && (await whichTool("clangd")) === null) {
      return { ran: false, ...empty };
    }

    const client =
      this.externalClient ?? new LspClient(["clangd", "--background-index=false"], repoRoot);
    const ownClient = this.externalClient === null;
    try {
      return {
        ran: true,
        ...(await runClangdIndexing(repoRoot, cppFiles, unitIds, client)),
      };
    } catch {
      return { ran: true, ...empty };
    } finally {
      if (ownClient) {
        try {
          await client.shutdown();
        } catch { /* ignore */ }
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
    diagnostics.push(...detectCyclicDeps(deps, "unit:cpp:"));

    if (await whichTool("cppcheck")) {
      const result = await exec(
        ["cppcheck", "--enable=warning,style", "--template={file}:{line}:{column}: {severity}: {message} [{id}]", "."],
        { cwd: repoRoot },
      );
      diagnostics.push(...parseCppcheckOutput(result.stderr, repoRoot));
    }
    return diagnostics;
  }
}

// --- helpers ---

function isSource(p: string): boolean {
  return CPP_SOURCE_EXT.some((e) => p.endsWith(e));
}
function isHeader(p: string): boolean {
  return CPP_HEADER_EXT.some((e) => p.endsWith(e));
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

async function hasAnySource(root: string, exts: string[]): Promise<boolean> {
  async function walk(dir: string, depth: number): Promise<boolean> {
    if (depth > 3) return false;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return false; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "build" || e.name === "node_modules") continue;
      if (e.isDirectory()) {
        if (await walk(resolve(dir, e.name), depth + 1)) return true;
      } else if (exts.some((x) => e.name.endsWith(x))) {
        return true;
      }
    }
    return false;
  }
  return walk(root, 0);
}

const SKIP_DIRS = new Set([
  "build",
  "build-debug",
  "build-release",
  "cmake-build-debug",
  "cmake-build-release",
  "node_modules",
  "third_party",
  "vendor",
  ".git",
]);

async function topLevelSourceDirs(repoRoot: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(repoRoot, { withFileTypes: true }); }
  catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    if (e.name === "include") continue; // headers — attributed via include-resolution
    if (await hasAnySource(resolve(repoRoot, e.name), CPP_SOURCE_EXT)) {
      out.push(e.name);
    }
  }
  return out;
}

async function findLooseHeaders(repoRoot: string, units: Unit[]): Promise<string[]> {
  // Scan typical header dirs that sit outside source units.
  const out: string[] = [];
  const unitPaths = new Set(units.map((u) => u.path));
  const candidates = ["include", "headers"];
  for (const candidate of candidates) {
    if (unitPaths.has(candidate)) continue;
    const abs = resolve(repoRoot, candidate);
    try { await stat(abs); } catch { continue; }
    const hdrs = await collectFiles(abs, CPP_HEADER_EXT, repoRoot);
    out.push(...hdrs);
  }
  return out;
}

const INCLUDE_RE = /^\s*#\s*include\s+"([^"]+)"/gm;

/** Extract local (`"foo.hpp"`-quoted) includes only — angle-bracket system headers are ignored. */
export function parseIncludes(source: string): string[] {
  const out: string[] = [];
  INCLUDE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INCLUDE_RE.exec(source)) !== null) out.push(m[1]!);
  return out;
}

/**
 * Run clangd over the .cpp/.hpp file set. clangd reads compile_commands.json
 * from the repo root when present and falls back to single-file mode otherwise.
 */
async function runClangdIndexing(
  repoRoot: string,
  cppFiles: Array<{ relPath: string; unitId: string }>,
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
  const interfaceSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];
  const funcSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];
  const refTargetSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];

  for (const { relPath } of cppFiles) {
    try {
      await client.openDocument(relPath, "cpp");
    } catch { /* ignore */ }
  }

  // clangd does not require workspace-readiness polling for single-file mode,
  // but with compile_commands.json it may take a couple of seconds to parse
  // and build the index. Probe documentSymbols on the first file.
  const probe = cppFiles[0]?.relPath;
  if (probe) {
    const start = Date.now();
    while (Date.now() - start < 60_000) {
      try {
        const res = await client.documentSymbols(probe, 5000);
        if (res.length > 0) break;
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  // 1. Collect symbols
  for (const { relPath, unitId } of cppFiles) {
    let lspSyms: LspDocumentSymbol[];
    try { lspSyms = await client.documentSymbols(relPath); } catch { continue; }
    for (const lspSym of flattenSymbols(lspSyms)) {
      const kind = CPP_SYMBOL_KIND_MAP[lspSym.kind];
      if (!kind) continue;
      const line = lspSym.selectionRange.start.line;
      const col = lspSym.selectionRange.start.character;
      const sym = lspSymbolToCppSymbol(lspSym, kind, relPath, unitId);
      symbols.push(sym);
      symbolByPos.set(`${relPath}:${line}:${col}`, sym);
      if (kind === "interface" || kind === "class" || kind === "struct") {
        interfaceSymbols.push({ symbol: sym, relPath, line, col });
        refTargetSymbols.push({ symbol: sym, relPath, line, col });
      }
      if (kind === "method" || kind === "constructor" || kind === "function") {
        funcSymbols.push({ symbol: sym, relPath, line, col });
      }
      if (kind === "field" || kind === "constant") {
        refTargetSymbols.push({ symbol: sym, relPath, line, col });
      }
    }
  }

  // 2. Call edges
  for (const { symbol, relPath, line, col } of funcSymbols) {
    let items;
    try { items = await client.prepareCallHierarchy(relPath, line, col); }
    catch { continue; }
    for (const item of items) {
      let outgoing;
      try { outgoing = await client.outgoingCalls(item); } catch { continue; }
      for (const call of outgoing) {
        const calleeRelPath = relative(repoRoot, LspClient.uriToPath(call.to.uri));
        let calleeSym = symbolByPos.get(
          `${calleeRelPath}:${call.to.selectionRange.start.line}:${call.to.selectionRange.start.character}`,
        );
        if (!calleeSym) {
          calleeSym = symbolByPos.get(
            `${calleeRelPath}:${call.to.range.start.line}:${call.to.range.start.character}`,
          );
        }
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

  // 3. Non-call refs
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
        targetSym.kind === "class" || targetSym.kind === "struct" || targetSym.kind === "interface"
          ? "type_ref"
          : targetSym.kind === "field"
            ? "field_access"
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

  // 4. type_relations via implementation (inheritance)
  for (const { symbol, relPath, line, col } of interfaceSymbols) {
    let impls;
    try { impls = await client.implementation(relPath, line, col); } catch { continue; }
    for (const impl of impls) {
      const implRelPath = relative(repoRoot, LspClient.uriToPath(impl.uri));
      const implSym = symbolByPos.get(`${implRelPath}:${impl.range.start.line}:${impl.range.start.character}`);
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

function lspSymbolToCppSymbol(
  lspSym: LspDocumentSymbol,
  kind: string,
  relPath: string,
  unitId: string,
): Symbol {
  const line = lspSym.selectionRange.start.line;
  const col = lspSym.selectionRange.start.character;
  const unitPath = unitId.replace(/^unit:cpp:/, "");
  const sigHash = hashSig(`${lspSym.name}:${lspSym.kind}:${line}`);
  return {
    id: `sym:cpp:${unitPath}#${kind}#${lspSym.name}#sig:${sigHash}`,
    unit_id: unitId,
    name: lspSym.name,
    kind,
    // clangd's documentSymbol does not expose linkage/access; default to true.
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
        (s.kind === "method" || s.kind === "constructor" || s.kind === "function"),
    )
    .sort((a, b) => a.decl.position.line - b.decl.position.line);
  for (let i = 0; i < fns.length; i++) {
    const sym = fns[i]!;
    const next = i + 1 < fns.length ? fns[i + 1]!.decl.position.line : Infinity;
    if (sym.decl.position.line <= line && line < next) return sym;
  }
  return null;
}

const CPPCHECK_RE =
  /^(.+?):(\d+):(\d+):\s*(error|warning|style|performance|portability|information):\s*(.+?)\s*\[([^\]]+)\]\s*$/gm;

export function parseCppcheckOutput(output: string, repoRoot: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  CPPCHECK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CPPCHECK_RE.exec(output)) !== null) {
    const filePath = m[1]!;
    const rel = relative(repoRoot, resolve(repoRoot, filePath));
    if (rel.startsWith("..")) continue;
    const severityRaw = m[4]!;
    const severity: Diagnostic["severity"] =
      severityRaw === "error" ? "error"
      : severityRaw === "warning" ? "warning"
      : severityRaw === "style" ? "info"
      : severityRaw === "performance" ? "info"
      : severityRaw === "portability" ? "info"
      : "info";
    out.push({
      file_id: `file:${rel}`,
      position: { line: parseInt(m[2]!, 10), column: parseInt(m[3]!, 10) },
      severity,
      message: `${m[5]!} [${m[6]!}]`,
      tool: "cppcheck",
    });
  }
  return out;
}

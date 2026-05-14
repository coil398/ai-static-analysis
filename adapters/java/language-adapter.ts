// JavaLanguageAdapter — JAVA_SPEC.md
//
// Strategy:
//   - detect: pom.xml (Maven) or settings.gradle(.kts) / build.gradle(.kts) (Gradle).
//   - enumerateUnits: each Maven module / Gradle subproject becomes one unit
//     (unit:java:<relPath>). For a single-project layout the root itself is the unit.
//   - indexUnits: collect .java files, parse `import` statements, resolve them to
//     known units by matching against each unit's package-root prefix. When jdtls
//     (Eclipse JDT LSP) is on PATH we drive it for full symbols / refs /
//     call_edges / type_relations; otherwise we degrade to the parser-based
//     top-level type extraction plus files + deps.
//   - diagnose: optionally run checkstyle / spotbugs / pmd if installed.

import { basename, relative, resolve } from "node:path";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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

interface ModuleInfo {
  unitId: string;
  name: string;
  /** Path relative to repoRoot. "." for a single-project repo. */
  relPath: string;
  /**
   * Java package prefixes this module owns (e.g. "com.example.lib").
   * Derived from src/main/java/<package>/... directory layout. Multiple
   * top-level packages per module are supported.
   */
  packagePrefixes: string[];
}

/** LSP DocumentSymbol kind → internal kind name. Matches the Java enum surface. */
const JAVA_SYMBOL_KIND_MAP: Record<number, string> = {
  5: "class",
  10: "enum",
  11: "interface",
  6: "method",
  9: "constructor",
  8: "field",
  14: "constant",
  13: "variable",
  22: "record",
  23: "record",
};

export class JavaLanguageAdapter implements LanguageAdapter {
  readonly lang = "java";

  private externalClient: LspClient | null = null;

  /** Reuse an externally-managed jdtls client (test injection / batch runs). */
  setExternalLspClient(client: LspClient | null): void {
    this.externalClient = client;
  }

  async detect(repoRoot: string): Promise<DetectResult> {
    const highConfidenceMarkers = [
      "pom.xml",
      "settings.gradle",
      "settings.gradle.kts",
      "build.gradle",
      "build.gradle.kts",
    ];
    for (const marker of highConfidenceMarkers) {
      if (await Bun.file(resolve(repoRoot, marker)).exists()) {
        return { supported: true, confidence: 1.0 };
      }
    }
    // Bare repo with .java files at root — low confidence.
    try {
      const hasJava = await this.firstJavaFile(repoRoot);
      if (hasJava) return { supported: true, confidence: 0.4 };
    } catch { /* ignore */ }
    return { supported: false, confidence: 0 };
  }

  async doctor(): Promise<DoctorResult> {
    const missing: string[] = [];
    const notes: string[] = [];

    const javac = (await whichTool("javac")) ?? (await whichTool("java"));
    if (!javac) {
      missing.push("javac");
    } else {
      const ver = await exec(["java", "-version"]);
      // `java -version` prints to stderr.
      const verLine = (ver.stderr || ver.stdout).split("\n")[0] ?? "";
      if (verLine) notes.push(verLine);
    }

    const optionalTools: Array<{ name: string; purpose: string }> = [
      { name: "jdtls", purpose: "symbols/refs/call_edges via Eclipse JDT LSP" },
      { name: "mvn", purpose: "Maven build / test / dependency resolution" },
      { name: "gradle", purpose: "Gradle build / test" },
      { name: "checkstyle", purpose: "style checks" },
      { name: "spotbugs", purpose: "bug pattern detection" },
      { name: "pmd", purpose: "static analysis" },
      { name: "google-java-format", purpose: "formatter" },
    ];
    for (const { name, purpose } of optionalTools) {
      if (!(await whichTool(name))) {
        notes.push(`${name} not found (optional, needed for ${purpose})`);
      } else {
        notes.push(`${name}: available`);
      }
    }

    return { ok: missing.length === 0, missing_tools: missing, notes };
  }

  async bootstrap(): Promise<BootstrapResult> {
    // Java toolchain installation is platform-specific (sdkman / brew /
    // apt / Chocolatey). Surface guidance rather than guessing — same
    // approach as the Go adapter takes for non-`go install` tools.
    return {
      installed: [],
      failed: [],
      notes: [
        "Java tooling install paths vary by OS. Suggested commands:",
        "  - JDK: install via your OS package manager or sdkman (`sdk install java`)",
        "  - jdtls: download from https://github.com/eclipse-jdtls/eclipse.jdt.ls/releases and add to PATH",
        "  - Maven: `brew install maven` / `apt install maven`",
        "  - Gradle: `brew install gradle` / `apt install gradle`",
      ],
    };
  }

  async enumerateUnits(
    repoRoot: string,
    _profile: Record<string, string>,
  ): Promise<Unit[]> {
    const modules = await this.detectModules(repoRoot);
    return modules.map((m) => ({
      id: m.unitId,
      kind: "java_module",
      name: m.name,
      path: m.relPath,
      metadata: {
        repo_root: repoRoot,
        package_prefixes: m.packagePrefixes,
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

    // Build a (prefix → unit_id) table so we can resolve imports without
    // re-walking the tree per file.
    const prefixToUnitId: Array<{ prefix: string; unitId: string }> = [];
    for (const u of units) {
      const prefixes = (u.metadata?.["package_prefixes"] as string[] | undefined) ?? [];
      for (const prefix of prefixes) {
        prefixToUnitId.push({ prefix, unitId: u.id });
      }
    }
    // Sort by length desc so we match the most specific prefix first.
    prefixToUnitId.sort((a, b) => b.prefix.length - a.prefix.length);

    const files: File[] = [];
    const deps: Dep[] = [];
    let symbols: Symbol[] = [];
    let refs: Ref[] = [];
    let typeRelations: TypeRelation[] = [];
    let callEdges: CallEdge[] = [];
    const seenDep = new Set<string>();
    const javaFiles: Array<{ relPath: string; unitId: string }> = [];

    for (const unit of units) {
      const unitDir = resolve(repoRoot, unit.path);
      const sourceFiles = await collectFiles(unitDir, [".java"], repoRoot);

      for (const relPath of sourceFiles) {
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

        if (generated) continue;

        javaFiles.push({ relPath, unitId: unit.id });

        const text = await safeRead(absPath);
        if (text === null) continue;

        for (const imported of parseImports(text)) {
          for (const { prefix, unitId } of prefixToUnitId) {
            if (imported === prefix || imported.startsWith(prefix + ".")) {
              if (unitId === unit.id) break;
              const key = `${unit.id}->${unitId}`;
              if (!seenDep.has(key)) {
                deps.push({
                  from_unit_id: unit.id,
                  to_unit_id: unitId,
                  kind: "import",
                });
                seenDep.add(key);
              }
              break;
            }
          }
        }
      }
    }

    // LSP-backed symbol/ref/call_edge/type_relation extraction. Falls back to
    // a parser-only top-level symbol scan when jdtls is unavailable so the
    // adapter still produces something useful in degraded mode.
    const lspResult = await this.indexWithJdtls(repoRoot, javaFiles, new Set(units.map((u) => u.id)));
    if (lspResult.ran) {
      symbols = lspResult.symbols;
      refs = lspResult.refs;
      typeRelations = lspResult.typeRelations;
      callEdges = lspResult.callEdges;
    } else {
      for (const { relPath, unitId } of javaFiles) {
        const text = await safeRead(resolve(repoRoot, relPath));
        if (text === null) continue;
        symbols.push(...parseTopLevelSymbols(text, unitId, relPath));
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

  /**
   * Drive jdtls (Eclipse JDT LSP) to produce LSP-backed facts for Java.
   * Returns `{ ran: false }` when jdtls is unavailable so the caller can fall
   * back to the parser-only path.
   */
  private async indexWithJdtls(
    repoRoot: string,
    javaFiles: Array<{ relPath: string; unitId: string }>,
    unitIds: Set<string>,
  ): Promise<{
    ran: boolean;
    symbols: Symbol[];
    refs: Ref[];
    typeRelations: TypeRelation[];
    callEdges: CallEdge[];
  }> {
    const empty = { symbols: [], refs: [], typeRelations: [], callEdges: [] };
    if (javaFiles.length === 0) return { ran: false, ...empty };

    if (!this.externalClient && (await whichTool("jdtls")) === null) {
      return { ran: false, ...empty };
    }

    let workspaceDir: string | null = null;
    let ownClient = false;
    let client: LspClient;
    if (this.externalClient) {
      client = this.externalClient;
    } else {
      workspaceDir = await mkdtemp(resolve(tmpdir(), "jdtls-ws-"));
      client = new LspClient(
        ["jdtls", "-data", workspaceDir],
        repoRoot,
        undefined,
        undefined,
        { handleServerRequests: true },
      );
      ownClient = true;
    }

    try {
      return {
        ran: true,
        ...(await runJdtlsIndexing(repoRoot, javaFiles, unitIds, client)),
      };
    } catch {
      return { ran: true, ...empty };
    } finally {
      if (ownClient) {
        try {
          await client.shutdown();
        } catch {
          /* ignore */
        }
      }
      if (workspaceDir) {
        await rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
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

    // Circular dependency detection runs without any external tool.
    const deps =
      inputDeps ??
      (await this.indexUnits(units, profile)).added.deps ??
      [];
    diagnostics.push(...detectCyclicDeps(deps, "unit:java:"));

    // checkstyle / pmd integration is opt-in: only run if the tool is on PATH
    // AND a config file is present. Otherwise we'd flood the diagnose pass
    // with default-style warnings for any project.
    if (await whichTool("checkstyle")) {
      const configPath = await findFirstExisting(repoRoot, [
        "checkstyle.xml",
        "config/checkstyle/checkstyle.xml",
      ]);
      if (configPath) {
        const result = await exec(
          ["checkstyle", "-c", configPath, "-f", "xml", "."],
          { cwd: repoRoot },
        );
        diagnostics.push(...parseCheckstyleXml(result.stdout, repoRoot));
      }
    }

    return diagnostics;
  }

  // --- helpers ---

  private async detectModules(repoRoot: string): Promise<ModuleInfo[]> {
    const rootPom = await Bun.file(resolve(repoRoot, "pom.xml")).exists();
    const rootSettings =
      (await Bun.file(resolve(repoRoot, "settings.gradle")).exists()) ||
      (await Bun.file(resolve(repoRoot, "settings.gradle.kts")).exists());

    // Maven multi-module: <modules><module>...</module></modules> in root pom.
    if (rootPom) {
      const modules = await parseMavenModules(resolve(repoRoot, "pom.xml"));
      if (modules.length > 0) {
        const infos: ModuleInfo[] = [];
        for (const modRel of modules) {
          const absPath = resolve(repoRoot, modRel);
          const prefixes = await detectPackagePrefixes(absPath);
          infos.push({
            unitId: `unit:java:${modRel}`,
            name: basename(modRel),
            relPath: modRel,
            packagePrefixes: prefixes,
          });
        }
        return infos;
      }
      // Single-module Maven project
      return [
        {
          unitId: "unit:java:.",
          name: basename(repoRoot),
          relPath: ".",
          packagePrefixes: await detectPackagePrefixes(repoRoot),
        },
      ];
    }

    // Gradle multi-project: parse `include` lines from settings.gradle(.kts).
    if (rootSettings) {
      const settingsPath = (await Bun.file(resolve(repoRoot, "settings.gradle")).exists())
        ? resolve(repoRoot, "settings.gradle")
        : resolve(repoRoot, "settings.gradle.kts");
      const modules = await parseGradleIncludes(settingsPath);
      if (modules.length > 0) {
        const infos: ModuleInfo[] = [];
        for (const modRel of modules) {
          const absPath = resolve(repoRoot, modRel);
          const prefixes = await detectPackagePrefixes(absPath);
          infos.push({
            unitId: `unit:java:${modRel}`,
            name: basename(modRel),
            relPath: modRel,
            packagePrefixes: prefixes,
          });
        }
        return infos;
      }
      return [
        {
          unitId: "unit:java:.",
          name: basename(repoRoot),
          relPath: ".",
          packagePrefixes: await detectPackagePrefixes(repoRoot),
        },
      ];
    }

    // No build script — fall back to a single unit if any .java exists.
    if (await this.firstJavaFile(repoRoot)) {
      return [
        {
          unitId: "unit:java:.",
          name: basename(repoRoot),
          relPath: ".",
          packagePrefixes: await detectPackagePrefixes(repoRoot),
        },
      ];
    }
    return [];
  }

  private async firstJavaFile(dir: string): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((e) => !e.isDirectory() && e.name.endsWith(".java"));
  }
}

// --- module-level helpers (exported for unit tests) ---

const IMPORT_RE = /^\s*import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;/gm;

/** Extract package names from a Java source string's import declarations. */
export function parseImports(source: string): string[] {
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const isWildcard = match[3] !== undefined;
    let pkg = match[2]!;
    if (!isWildcard) {
      // Drop the trailing identifier: for a normal type import that's the
      // class name; for a static import it's the imported member.
      const idx = pkg.lastIndexOf(".");
      if (idx > 0) pkg = pkg.slice(0, idx);
    }
    if (pkg) out.push(pkg);
  }
  return out;
}

const TYPE_DECL_RE =
  /^([ \t]*(?:(?:public|private|protected|abstract|final|sealed|non-sealed|static)[ \t]+)*)(class|interface|enum|record)[ \t]+(\w+)/gm;

/** Emit one Symbol per top-level type declaration. Methods/fields are skipped. */
export function parseTopLevelSymbols(
  source: string,
  unitId: string,
  relPath: string,
): Symbol[] {
  const out: Symbol[] = [];
  TYPE_DECL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TYPE_DECL_RE.exec(source)) !== null) {
    const modifiers = match[1]!;
    const kind = match[2]!;
    const name = match[3]!;
    // The kind keyword starts after the indent + modifiers prefix.
    const keywordOffset = match.index + modifiers.length;
    let line = 1;
    let lastNewline = -1;
    for (let i = 0; i < keywordOffset; i++) {
      if (source.charCodeAt(i) === 10) {
        line++;
        lastNewline = i;
      }
    }
    const column = keywordOffset - lastNewline;
    const unitPath = unitId.replace(/^unit:java:/, "");
    const sigHash = hashSig(`${name}:${kind}:${line}`);
    out.push({
      id: `sym:java:${unitPath}#${kind}#${name}#sig:${sigHash}`,
      unit_id: unitId,
      name,
      kind,
      // Top-level types with `private` or `protected` aren't exported. Anything
      // else (including the implicit package-private default) we surface.
      exported: !/\b(private|protected)\b/.test(modifiers),
      decl: {
        file_id: `file:${relPath}`,
        position: { line, column },
      },
    });
  }
  return out;
}

/**
 * Drive a (potentially shared) jdtls LSP session across the full set of
 * .java files in a repo: open every file, wait for the workspace to be
 * indexed, then run documentSymbol / prepareCallHierarchy+outgoingCalls /
 * references / implementation passes.
 *
 * Mirrors the C# adapter's csharp-ls integration but with Java symbol-kind
 * mapping and `sym:java:` id conventions. jdtls loads project metadata
 * asynchronously, so we probe documentSymbols on a representative file until
 * we get a non-empty response (capped at 90 s, same envelope as csharp-ls).
 */
async function runJdtlsIndexing(
  repoRoot: string,
  javaFiles: Array<{ relPath: string; unitId: string }>,
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

  // "relPath:line:col" → Symbol — used for resolving LSP locations back to
  // an emitted Symbol.
  const symbolByPos = new Map<string, Symbol>();
  const interfaceSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];
  const funcSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];
  const refTargetSymbols: Array<{ symbol: Symbol; relPath: string; line: number; col: number }> = [];

  // 0. Open every file. Failure on any single open shouldn't kill the run —
  //    jdtls happily serves the rest.
  for (const { relPath } of javaFiles) {
    try {
      await client.openDocument(relPath, "java");
    } catch { /* ignore */ }
  }

  // Probe documentSymbols on the first file until we get a non-empty reply.
  // jdtls indexes the workspace asynchronously and returns [] until it's done.
  const probeFile = javaFiles[0]?.relPath;
  if (probeFile) {
    const PROBE_TIMEOUT_MS = 5_000;
    const start = Date.now();
    while (Date.now() - start < 90_000) {
      try {
        const probe = await client.documentSymbols(probeFile, PROBE_TIMEOUT_MS);
        if (probe.length > 0) break;
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  // 1. Collect symbols from every file.
  for (const { relPath, unitId } of javaFiles) {
    let lspSyms: LspDocumentSymbol[];
    try {
      lspSyms = await client.documentSymbols(relPath);
    } catch {
      continue;
    }
    const flat = flattenDocumentSymbols(lspSyms);
    for (const lspSym of flat) {
      const kind = JAVA_SYMBOL_KIND_MAP[lspSym.kind];
      if (!kind) continue;
      const line = lspSym.selectionRange.start.line;
      const col = lspSym.selectionRange.start.character;
      const sym = lspSymbolToJavaSymbol(lspSym, kind, relPath, unitId);
      symbols.push(sym);
      symbolByPos.set(`${relPath}:${line}:${col}`, sym);

      if (kind === "interface") {
        interfaceSymbols.push({ symbol: sym, relPath, line, col });
      }
      if (kind === "method" || kind === "constructor") {
        funcSymbols.push({ symbol: sym, relPath, line, col });
      }
      if (
        kind === "class" ||
        kind === "interface" ||
        kind === "enum" ||
        kind === "record" ||
        kind === "field" ||
        kind === "constant"
      ) {
        refTargetSymbols.push({ symbol: sym, relPath, line, col });
      }
    }
  }

  // 2. Call edges via prepareCallHierarchy + outgoingCalls.
  for (const { symbol, relPath, line, col } of funcSymbols) {
    let items;
    try {
      items = await client.prepareCallHierarchy(relPath, line, col);
    } catch {
      continue;
    }
    for (const item of items) {
      let outgoing;
      try {
        outgoing = await client.outgoingCalls(item);
      } catch {
        continue;
      }
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

  // 3. Non-call refs (type_ref, field_access, reference).
  const callRefKeys = new Set(
    refs.map(
      (r) => `${r.to_symbol_id}@${r.site.file_id}:${r.site.position.line}:${r.site.position.column}`,
    ),
  );
  for (const { symbol: targetSym, relPath: tRelPath, line: tLine, col: tCol } of refTargetSymbols) {
    let refLocs;
    try {
      refLocs = await client.references(tRelPath, tLine, tCol);
    } catch {
      continue;
    }
    for (const loc of refLocs) {
      const locRelPath = relative(repoRoot, LspClient.uriToPath(loc.uri));
      // The decl site itself is included in references — skip it.
      if (
        locRelPath === tRelPath &&
        loc.range.start.line === tLine &&
        loc.range.start.character === tCol
      ) {
        continue;
      }
      const fileId = `file:${locRelPath}`;
      const locLine = loc.range.start.line + 1;
      const locCol = loc.range.start.character + 1;
      const refKey = `${targetSym.id}@${fileId}:${locLine}:${locCol}`;
      if (callRefKeys.has(refKey)) continue;
      const fromSymbol = findEnclosingSymbol(symbols, fileId, locLine);
      const kind =
        targetSym.kind === "class" || targetSym.kind === "interface" ||
        targetSym.kind === "enum" || targetSym.kind === "record"
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

  // 4. type_relations via textDocument/implementation on every interface.
  for (const { symbol, relPath, line, col } of interfaceSymbols) {
    let impls;
    try {
      impls = await client.implementation(relPath, line, col);
    } catch {
      continue;
    }
    for (const impl of impls) {
      const implRelPath = relative(repoRoot, LspClient.uriToPath(impl.uri));
      const implLine = impl.range.start.line;
      const implCol = impl.range.start.character;
      const implSym = symbolByPos.get(`${implRelPath}:${implLine}:${implCol}`);
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

function flattenDocumentSymbols(syms: LspDocumentSymbol[]): LspDocumentSymbol[] {
  const out: LspDocumentSymbol[] = [];
  for (const s of syms) {
    out.push(s);
    if (s.children?.length) out.push(...flattenDocumentSymbols(s.children));
  }
  return out;
}

function lspSymbolToJavaSymbol(
  lspSym: LspDocumentSymbol,
  kind: string,
  relPath: string,
  unitId: string,
): Symbol {
  const line = lspSym.selectionRange.start.line;
  const col = lspSym.selectionRange.start.character;
  const sigHash = hashSig(`${lspSym.name}:${lspSym.kind}:${line}`);
  const unitPath = unitId.replace(/^unit:java:/, "");
  return {
    id: `sym:java:${unitPath}#${kind}#${lspSym.name}#sig:${sigHash}`,
    unit_id: unitId,
    name: lspSym.name,
    kind,
    // jdtls documentSymbol does not expose access modifiers, so we cannot tell
    // private/protected from public here. Conservatively treat everything as
    // exported (mirrors the C# adapter).
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
  const candidates = symbols
    .filter(
      (s) =>
        s.decl.file_id === fileId &&
        (s.kind === "method" || s.kind === "constructor"),
    )
    .sort((a, b) => a.decl.position.line - b.decl.position.line);
  for (let i = 0; i < candidates.length; i++) {
    const sym = candidates[i]!;
    const next = i + 1 < candidates.length ? candidates[i + 1]!.decl.position.line : Infinity;
    if (sym.decl.position.line <= line && line < next) return sym;
  }
  return null;
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

const MAVEN_MODULE_RE = /<module>\s*([^<\s]+)\s*<\/module>/g;

async function parseMavenModules(pomPath: string): Promise<string[]> {
  const text = await safeRead(pomPath);
  if (text === null) return [];
  const out: string[] = [];
  MAVEN_MODULE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MAVEN_MODULE_RE.exec(text)) !== null) {
    out.push(m[1]!);
  }
  return out;
}

const GRADLE_INCLUDE_RE = /^\s*include\s*\(?\s*['"]([^'"]+)['"]/gm;

async function parseGradleIncludes(settingsPath: string): Promise<string[]> {
  const text = await safeRead(settingsPath);
  if (text === null) return [];
  const out: string[] = [];
  GRADLE_INCLUDE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GRADLE_INCLUDE_RE.exec(text)) !== null) {
    // Gradle accepts `:foo:bar` as well as `foo`. Strip the leading colon and
    // convert colons to slashes for paths on disk.
    const id = m[1]!.replace(/^:+/, "").replace(/:/g, "/");
    if (id) out.push(id);
  }
  return out;
}

/**
 * Walk src/main/java looking for the first directory that has a .java file —
 * its path is the module's package root. We collect up to a couple of distinct
 * roots in case the module has multiple top-level packages.
 */
async function detectPackagePrefixes(moduleDir: string): Promise<string[]> {
  const roots: string[] = [];
  const srcMainJava = resolve(moduleDir, "src/main/java");
  const startDir = (await dirExists(srcMainJava)) ? srcMainJava : moduleDir;

  async function walk(dir: string, packageSoFar: string): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    if (entries.some((e) => !e.isDirectory() && e.name.endsWith(".java"))) {
      if (packageSoFar) roots.push(packageSoFar);
      return true;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subPackage = packageSoFar
        ? `${packageSoFar}.${entry.name}`
        : entry.name;
      if (await walk(resolve(dir, entry.name), subPackage)) {
        // Keep walking siblings so multi-root modules are handled.
      }
      if (roots.length >= 8) break;
    }
    return false;
  }

  await walk(startDir, "");
  // De-dupe.
  return [...new Set(roots)];
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function findFirstExisting(
  repoRoot: string,
  candidates: string[],
): Promise<string | null> {
  for (const rel of candidates) {
    const abs = resolve(repoRoot, rel);
    if (await Bun.file(abs).exists()) return abs;
  }
  return null;
}

/**
 * Minimal checkstyle XML parser — just enough to recover (file, line, severity,
 * message). The full XML spec is overkill for a single namespace-free schema.
 */
export function parseCheckstyleXml(xml: string, repoRoot: string): Diagnostic[] {
  if (!xml.trim()) return [];
  const out: Diagnostic[] = [];
  const fileRe = /<file\s+name="([^"]+)">([\s\S]*?)<\/file>/g;
  const errRe =
    /<error\s+line="(\d+)"(?:\s+column="(\d+)")?\s+severity="([^"]+)"\s+message="([^"]+)"[^/]*\/>/g;
  let fileMatch: RegExpExecArray | null;
  while ((fileMatch = fileRe.exec(xml)) !== null) {
    const absPath = fileMatch[1]!;
    const body = fileMatch[2]!;
    const relPath = relative(repoRoot, absPath);
    if (relPath.startsWith("..")) continue;
    errRe.lastIndex = 0;
    let em: RegExpExecArray | null;
    while ((em = errRe.exec(body)) !== null) {
      const severityRaw = em[3]!;
      const severity: Diagnostic["severity"] =
        severityRaw === "error"
          ? "error"
          : severityRaw === "warning"
            ? "warning"
            : severityRaw === "info"
              ? "info"
              : "hint";
      out.push({
        file_id: `file:${relPath}`,
        position: {
          line: parseInt(em[1]!, 10),
          column: em[2] ? parseInt(em[2], 10) : 1,
        },
        severity,
        message: unescapeXml(em[4]!),
        tool: "checkstyle",
      });
    }
  }
  return out;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

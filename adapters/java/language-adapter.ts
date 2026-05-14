// JavaLanguageAdapter — JAVA_SPEC.md
//
// Strategy:
//   - detect: pom.xml (Maven) or settings.gradle(.kts) / build.gradle(.kts) (Gradle).
//   - enumerateUnits: each Maven module / Gradle subproject becomes one unit
//     (unit:java:<relPath>). For a single-project layout the root itself is the unit.
//   - indexUnits: collect .java files, parse `import` statements, resolve them to
//     known units by matching against each unit's package-root prefix. Symbol /
//     ref / call_edge extraction is best-effort and depends on jdtls (Eclipse JDT
//     LSP). When jdtls is not installed the adapter degrades to file + deps only.
//   - diagnose: optionally run checkstyle / spotbugs / pmd if installed.

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

export class JavaLanguageAdapter implements LanguageAdapter {
  readonly lang = "java";

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
    const symbols: Symbol[] = [];
    const seenDep = new Set<string>();

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

        const text = await safeRead(absPath);
        if (text === null) continue;

        // Imports → deps.
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

        // Top-level declarations → symbols. We only emit `class`/`interface`/
        // `enum`/`record` declarations: methods/fields require an actual
        // parser (jdtls integration) and would otherwise be noisy.
        symbols.push(...parseTopLevelSymbols(text, unit.id, relPath));
      }
    }

    return {
      added: {
        units,
        files,
        deps,
        symbols,
      },
      removed: {},
    };
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

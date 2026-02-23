import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Facts, Fingerprint, Insights, Ref } from "../schema/index.ts";

const FACTS_FILE = "facts.json";
const FACTS_DIR = "facts";
const FINGERPRINT_FILE = "fingerprint.json";
const INSIGHTS_FILE = "insights.json";

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function readJson<T>(path: string): Promise<T | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return (await file.json()) as T;
}

async function writeJson<T>(path: string, data: T): Promise<void> {
  await Bun.write(path, JSON.stringify(data, null, 2) + "\n");
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

// --- JSONL helpers ---

async function readJsonl<T>(path: string): Promise<T[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

async function writeJsonl<T>(path: string, items: T[]): Promise<void> {
  const lines = items.map((item) => JSON.stringify(item)).join("\n");
  await Bun.write(path, lines + "\n");
}

// --- Facts ---

export async function readFacts(cacheDir: string): Promise<Facts | null> {
  // Auto-detect: JSONL dir takes priority over legacy JSON file
  const factsDir = join(cacheDir, FACTS_DIR);
  if (await dirExists(factsDir)) {
    return readFactsJsonl(cacheDir);
  }
  return readJson<Facts>(join(cacheDir, FACTS_FILE));
}

async function readFactsJsonl(cacheDir: string): Promise<Facts | null> {
  const factsDir = join(cacheDir, FACTS_DIR);
  const meta = await readJson<Pick<Facts, "schema_version" | "snapshot" | "meta">>(
    join(factsDir, "meta.json"),
  );
  if (!meta) return null;

  const [units, files, deps, symbols, refs, type_relations, call_edges, diagnostics] =
    await Promise.all([
      readJsonl(join(factsDir, "units.jsonl")),
      readJsonl(join(factsDir, "files.jsonl")),
      readJsonl(join(factsDir, "deps.jsonl")),
      readJsonl(join(factsDir, "symbols.jsonl")),
      readJsonl(join(factsDir, "refs.jsonl")),
      readJsonl(join(factsDir, "type_relations.jsonl")),
      readJsonl(join(factsDir, "call_edges.jsonl")),
      readJsonl(join(factsDir, "diagnostics.jsonl")),
    ]);

  return {
    schema_version: meta.schema_version,
    snapshot: meta.snapshot,
    meta: meta.meta,
    units: units as Facts["units"],
    files: files as Facts["files"],
    deps: deps as Facts["deps"],
    symbols: symbols as Facts["symbols"],
    refs: refs as Facts["refs"],
    type_relations: type_relations as Facts["type_relations"],
    call_edges: call_edges as Facts["call_edges"],
    diagnostics: diagnostics as Facts["diagnostics"],
  };
}

export async function writeFacts(
  cacheDir: string,
  facts: Facts,
): Promise<void> {
  await ensureDir(cacheDir);
  await writeJson(join(cacheDir, FACTS_FILE), facts);
}

export async function writeFactsJsonl(
  cacheDir: string,
  facts: Facts,
): Promise<void> {
  const factsDir = join(cacheDir, FACTS_DIR);
  await ensureDir(factsDir);

  const meta: Pick<Facts, "schema_version" | "snapshot" | "meta"> = {
    schema_version: facts.schema_version,
    snapshot: facts.snapshot,
    meta: facts.meta,
  };

  await Promise.all([
    writeJson(join(factsDir, "meta.json"), meta),
    writeJsonl(join(factsDir, "units.jsonl"), facts.units),
    writeJsonl(join(factsDir, "files.jsonl"), facts.files),
    writeJsonl(join(factsDir, "deps.jsonl"), facts.deps),
    writeJsonl(join(factsDir, "symbols.jsonl"), facts.symbols),
    writeJsonl(join(factsDir, "refs.jsonl"), facts.refs),
    writeJsonl(join(factsDir, "type_relations.jsonl"), facts.type_relations),
    writeJsonl(join(factsDir, "call_edges.jsonl"), facts.call_edges),
    writeJsonl(join(factsDir, "diagnostics.jsonl"), facts.diagnostics),
  ]);
}

// --- Fingerprint ---

export async function readFingerprint(
  cacheDir: string,
): Promise<Fingerprint | null> {
  return readJson<Fingerprint>(join(cacheDir, FINGERPRINT_FILE));
}

export async function writeFingerprint(
  cacheDir: string,
  fp: Fingerprint,
): Promise<void> {
  await ensureDir(cacheDir);
  await writeJson(join(cacheDir, FINGERPRINT_FILE), fp);
}

// --- Insights ---

export async function readInsights(cacheDir: string): Promise<Insights | null> {
  return readJson<Insights>(join(cacheDir, INSIGHTS_FILE));
}

export async function writeInsights(
  cacheDir: string,
  insights: Insights,
): Promise<void> {
  await ensureDir(cacheDir);
  await writeJson(join(cacheDir, INSIGHTS_FILE), insights);
}

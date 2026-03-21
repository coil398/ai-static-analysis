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

/** Fields that can be selectively loaded from JSONL storage. */
export type FactsField =
  | "units"
  | "files"
  | "deps"
  | "symbols"
  | "refs"
  | "type_relations"
  | "call_edges"
  | "diagnostics";

const ALL_FIELDS: FactsField[] = [
  "units", "files", "deps", "symbols", "refs",
  "type_relations", "call_edges", "diagnostics",
];

const FIELD_TO_FILE: Record<FactsField, string> = {
  units: "units.jsonl",
  files: "files.jsonl",
  deps: "deps.jsonl",
  symbols: "symbols.jsonl",
  refs: "refs.jsonl",
  type_relations: "type_relations.jsonl",
  call_edges: "call_edges.jsonl",
  diagnostics: "diagnostics.jsonl",
};

export async function readFacts(cacheDir: string): Promise<Facts | null> {
  // Auto-detect: JSONL dir takes priority over legacy JSON file
  const factsDir = join(cacheDir, FACTS_DIR);
  if (await dirExists(factsDir)) {
    return readFactsJsonl(cacheDir);
  }
  return readJson<Facts>(join(cacheDir, FACTS_FILE));
}

/**
 * Read only the specified fields from JSONL storage.
 * Unloaded fields are set to empty arrays.
 * Falls back to full read for legacy JSON format.
 */
export async function readFactsPartial(
  cacheDir: string,
  fields: FactsField[],
): Promise<Facts | null> {
  const factsDir = join(cacheDir, FACTS_DIR);
  if (!(await dirExists(factsDir))) {
    // Legacy JSON — no partial read possible, load everything
    return readJson<Facts>(join(cacheDir, FACTS_FILE));
  }

  const meta = await readJson<Pick<Facts, "schema_version" | "snapshot" | "meta">>(
    join(factsDir, "meta.json"),
  );
  if (!meta) return null;

  const fieldSet = new Set(fields);
  const results = await Promise.all(
    ALL_FIELDS.map((f) =>
      fieldSet.has(f)
        ? readJsonl(join(factsDir, FIELD_TO_FILE[f]))
        : Promise.resolve([]),
    ),
  );

  return {
    schema_version: meta.schema_version,
    snapshot: meta.snapshot,
    meta: meta.meta,
    units: results[0] as Facts["units"],
    files: results[1] as Facts["files"],
    deps: results[2] as Facts["deps"],
    symbols: results[3] as Facts["symbols"],
    refs: results[4] as Facts["refs"],
    type_relations: results[5] as Facts["type_relations"],
    call_edges: results[6] as Facts["call_edges"],
    diagnostics: results[7] as Facts["diagnostics"],
  };
}

async function readFactsJsonl(cacheDir: string): Promise<Facts | null> {
  return readFactsPartial(cacheDir, ALL_FIELDS);
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

  // Write data files first, then meta.json last.
  // If interrupted, stale meta.json signals inconsistency on next read.
  await writeJsonl(join(factsDir, "units.jsonl"), facts.units);
  await writeJsonl(join(factsDir, "files.jsonl"), facts.files);
  await writeJsonl(join(factsDir, "deps.jsonl"), facts.deps);
  await writeJsonl(join(factsDir, "symbols.jsonl"), facts.symbols);
  await writeJsonl(join(factsDir, "refs.jsonl"), facts.refs);
  await writeJsonl(join(factsDir, "type_relations.jsonl"), facts.type_relations);
  await writeJsonl(join(factsDir, "call_edges.jsonl"), facts.call_edges);
  await writeJsonl(join(factsDir, "diagnostics.jsonl"), facts.diagnostics);
  await writeJson(join(factsDir, "meta.json"), meta);
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

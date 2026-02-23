// Derived indexes for large-scale query optimization
//
// Indexes are generated from Facts and stored in cache/index/.
// All indexes are optional — query functions fall back to full scan when absent.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Facts, Ref } from "../schema/index.ts";

const INDEX_DIR = "index";

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

function indexDir(cacheDir: string): string {
  return join(cacheDir, INDEX_DIR);
}

// --- Build ---

/**
 * Generate all derived indexes from Facts and write them to cache/index/.
 * Called automatically after writeFacts() in the index skill.
 */
export async function buildIndexes(cacheDir: string, facts: Facts): Promise<void> {
  const dir = indexDir(cacheDir);
  await ensureDir(dir);

  // unit_by_file: file_id → unit_id
  const unitByFile: Record<string, string> = {};
  for (const f of facts.files) {
    unitByFile[f.id] = f.unit_id;
  }

  // symbol_by_name: name → symbol_id[]
  const symbolByName: Record<string, string[]> = {};
  for (const s of facts.symbols) {
    if (!symbolByName[s.name]) symbolByName[s.name] = [];
    symbolByName[s.name].push(s.id);
  }

  // refs_by_symbol: to_symbol_id → Ref[]
  const refsBySymbol: Record<string, Ref[]> = {};
  for (const r of facts.refs) {
    if (!refsBySymbol[r.to_symbol_id]) refsBySymbol[r.to_symbol_id] = [];
    refsBySymbol[r.to_symbol_id].push(r);
  }

  await Promise.all([
    writeJson(join(dir, "unit_by_file.json"), unitByFile),
    writeJson(join(dir, "symbol_by_name.json"), symbolByName),
    writeJson(join(dir, "refs_by_symbol.json"), refsBySymbol),
  ]);
}

// --- Load ---

export async function loadUnitByFile(
  cacheDir: string,
): Promise<Record<string, string> | null> {
  return readJson<Record<string, string>>(
    join(indexDir(cacheDir), "unit_by_file.json"),
  );
}

export async function loadSymbolByName(
  cacheDir: string,
): Promise<Record<string, string[]> | null> {
  return readJson<Record<string, string[]>>(
    join(indexDir(cacheDir), "symbol_by_name.json"),
  );
}

export async function loadRefsBySymbol(
  cacheDir: string,
): Promise<Record<string, Ref[]> | null> {
  return readJson<Record<string, Ref[]>>(
    join(indexDir(cacheDir), "refs_by_symbol.json"),
  );
}

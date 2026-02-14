import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Facts, Fingerprint } from "../schema/index.ts";

const FACTS_FILE = "facts.json";
const FINGERPRINT_FILE = "fingerprint.json";

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

export async function readFacts(cacheDir: string): Promise<Facts | null> {
  return readJson<Facts>(join(cacheDir, FACTS_FILE));
}

export async function writeFacts(
  cacheDir: string,
  facts: Facts,
): Promise<void> {
  await ensureDir(cacheDir);
  await writeJson(join(cacheDir, FACTS_FILE), facts);
}

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

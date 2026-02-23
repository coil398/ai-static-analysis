// index-facts skill — full indexing of a codebase

import { join } from "node:path";
import type { Facts, FactsDelta } from "../core/schema/types.ts";
import type { Fingerprint } from "../core/schema/types.ts";
import {
  generateFingerprint,
  compareFingerprint,
  wipeCache,
} from "../core/fingerprint/index.ts";
import {
  readFacts,
  writeFacts,
  readFingerprint,
  writeFingerprint,
} from "../core/storage/index.ts";
import { applyDelta } from "../core/diff/index.ts";
import { buildIndexes } from "../core/index/index.ts";
import { createRegistry } from "./registry.ts";

export interface IndexOptions {
  repoRoot: string;
  cacheDir?: string;
  profile?: Record<string, string>;
}

export interface IndexResult {
  ok: boolean;
  facts: Facts;
  fingerprint: Fingerprint;
  errors: string[];
  warnings: string[];
}

export async function indexFacts(options: IndexOptions): Promise<IndexResult> {
  const { repoRoot, profile = {} } = options;
  const cacheDir = options.cacheDir ?? join(repoRoot, "cache");
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Generate fingerprint and compare with cached
  const fingerprint = await generateFingerprint(repoRoot, { profile });
  const cachedFp = await readFingerprint(cacheDir);
  if (cachedFp) {
    const cmp = compareFingerprint(fingerprint, cachedFp);
    if (!cmp.match) {
      warnings.push(
        `Fingerprint mismatch, wiping cache: ${cmp.diffs.join(", ")}`,
      );
      await wipeCache(cacheDir);
    }
  }

  // 2. Detect languages
  const registry = createRegistry();
  const detected = await registry.detectAll(repoRoot);
  if (detected.length === 0) {
    warnings.push("No supported languages detected");
  }

  // 3. Doctor check — skip languages that fail
  const activeLangs: string[] = [];
  for (const { lang } of detected) {
    const adapter = registry.getLanguageAdapter(lang)!;
    const doc = await adapter.doctor();
    if (doc.ok) {
      activeLangs.push(lang);
    } else {
      warnings.push(
        `Skipping ${lang}: missing tools [${doc.missing_tools.join(", ")}]`,
      );
    }
  }

  // 4. Enumerate units for all active languages
  const allUnits = (
    await Promise.all(
      activeLangs.map(async (lang) => {
        const adapter = registry.getLanguageAdapter(lang)!;
        try {
          return await adapter.enumerateUnits(repoRoot, profile);
        } catch (e) {
          errors.push(`${lang}: enumerateUnits failed: ${e}`);
          return [];
        }
      }),
    )
  ).flat();

  // 5. Index units — collect deltas and apply to empty facts
  let facts: Facts = {
    schema_version: 1,
    snapshot: {
      commit: fingerprint.repo_state.commit,
      created_at: new Date().toISOString(),
    },
    units: [],
    files: [],
    deps: [],
    symbols: [],
    refs: [],
    type_relations: [],
    call_edges: [],
    diagnostics: [],
  };

  for (const lang of activeLangs) {
    const adapter = registry.getLanguageAdapter(lang)!;
    const langUnits = allUnits.filter(
      (u) => u.id.startsWith(`unit:${lang}:`),
    );
    if (langUnits.length === 0) continue;
    try {
      const delta = await adapter.indexUnits(langUnits, profile);
      facts = applyDelta(facts, delta);
    } catch (e) {
      errors.push(`${lang}: indexUnits failed: ${e}`);
    }
  }

  // 6. Diagnose
  for (const lang of activeLangs) {
    const adapter = registry.getLanguageAdapter(lang)!;
    const langUnits = facts.units.filter(
      (u) => u.id.startsWith(`unit:${lang}:`),
    );
    if (langUnits.length === 0) continue;
    try {
      const diags = await adapter.diagnose(langUnits, profile);
      facts.diagnostics.push(...diags);
    } catch (e) {
      warnings.push(`${lang}: diagnose failed: ${e}`);
    }
  }

  // 7. Persist
  await writeFacts(cacheDir, facts);
  await writeFingerprint(cacheDir, fingerprint);
  await buildIndexes(cacheDir, facts);

  return {
    ok: errors.length === 0,
    facts,
    fingerprint,
    errors,
    warnings,
  };
}

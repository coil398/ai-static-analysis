// update-facts skill — differential update of facts for changed files

import { join } from "node:path";
import type { Facts, FactsDelta } from "../core/schema/types.ts";
import {
  generateFingerprint,
  compareFingerprint,
} from "../core/fingerprint/index.ts";
import {
  readFacts,
  writeFacts,
  readFingerprint,
} from "../core/storage/index.ts";
import { applyDelta, impactUnits } from "../core/diff/index.ts";
import { createRegistry } from "./registry.ts";
import { indexFacts, type IndexOptions } from "./index.ts";

export interface UpdateOptions {
  repoRoot: string;
  changedFiles: string[];
  cacheDir?: string;
  profile?: Record<string, string>;
}

export interface UpdateResult {
  ok: boolean;
  facts: Facts;
  affectedUnits: string[];
  fallbackToIndex: boolean;
  errors: string[];
  warnings: string[];
}

export async function updateFacts(
  options: UpdateOptions,
): Promise<UpdateResult> {
  const { repoRoot, changedFiles, profile = {} } = options;
  const cacheDir = options.cacheDir ?? join(repoRoot, "cache");
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Fingerprint check
  const fingerprint = await generateFingerprint(repoRoot, { profile });
  const cachedFp = await readFingerprint(cacheDir);
  if (!cachedFp || !compareFingerprint(fingerprint, cachedFp).match) {
    warnings.push("Fingerprint mismatch or missing, falling back to full index");
    const indexResult = await indexFacts({ repoRoot, cacheDir, profile });
    return {
      ok: indexResult.ok,
      facts: indexResult.facts,
      affectedUnits: indexResult.facts.units.map((u) => u.id),
      fallbackToIndex: true,
      errors: indexResult.errors,
      warnings: [...warnings, ...indexResult.warnings],
    };
  }

  // 2. Read existing facts
  const existingFacts = await readFacts(cacheDir);
  if (!existingFacts) {
    warnings.push("No cached facts found, falling back to full index");
    const indexResult = await indexFacts({ repoRoot, cacheDir, profile });
    return {
      ok: indexResult.ok,
      facts: indexResult.facts,
      affectedUnits: indexResult.facts.units.map((u) => u.id),
      fallbackToIndex: true,
      errors: indexResult.errors,
      warnings: [...warnings, ...indexResult.warnings],
    };
  }

  // 3. Determine affected units
  const affectedUnits = impactUnits(changedFiles, existingFacts);
  if (affectedUnits.length === 0) {
    warnings.push("No units affected by changed files");
    return {
      ok: true,
      facts: existingFacts,
      affectedUnits: [],
      fallbackToIndex: false,
      errors,
      warnings,
    };
  }

  // 4. Re-index affected units
  const registry = createRegistry();
  const affectedUnitSet = new Set(affectedUnits);
  const unitsToReindex = existingFacts.units.filter((u) =>
    affectedUnitSet.has(u.id),
  );

  // Group units by language
  const unitsByLang = new Map<string, typeof unitsToReindex>();
  for (const unit of unitsToReindex) {
    // Extract lang from unit id: "unit:<lang>:<path>"
    const lang = unit.id.split(":")[1]!;
    const list = unitsByLang.get(lang) ?? [];
    list.push(unit);
    unitsByLang.set(lang, list);
  }

  // 5. Build removal delta for old data of affected units
  const removalDelta: FactsDelta = {
    added: {},
    removed: {
      units: affectedUnits,
    },
  };

  // Apply removal first
  let facts = applyDelta(existingFacts, removalDelta);

  // 6. Re-index each language's affected units
  for (const [lang, langUnits] of unitsByLang) {
    const adapter = registry.getLanguageAdapter(lang);
    if (!adapter) {
      errors.push(`No adapter for language: ${lang}`);
      continue;
    }
    try {
      const delta = await adapter.indexUnits(langUnits, profile);
      facts = applyDelta(facts, delta);
    } catch (e) {
      errors.push(`${lang}: indexUnits failed: ${e}`);
    }
  }

  // 7. Re-diagnose affected units
  for (const [lang, langUnits] of unitsByLang) {
    const adapter = registry.getLanguageAdapter(lang);
    if (!adapter) continue;
    // Use newly indexed units from facts
    const newUnits = facts.units.filter((u) =>
      langUnits.some((lu) => lu.id === u.id),
    );
    if (newUnits.length === 0) continue;
    try {
      const diags = await adapter.diagnose(newUnits, profile);
      facts.diagnostics.push(...diags);
    } catch (e) {
      warnings.push(`${lang}: diagnose failed: ${e}`);
    }
  }

  // 8. Persist
  await writeFacts(cacheDir, facts);

  return {
    ok: errors.length === 0,
    facts,
    affectedUnits,
    fallbackToIndex: false,
    errors,
    warnings,
  };
}

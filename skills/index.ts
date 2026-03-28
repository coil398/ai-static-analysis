// index-facts skill — full indexing of a codebase

import { join } from "node:path";
import type { Facts, Unit, Fingerprint } from "../core/schema/types.ts";
import {
  generateFingerprint,
  compareFingerprint,
  wipeCache,
} from "../core/fingerprint/index.ts";
import {
  writeFactsJsonl,
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
  onProgress?: (message: string) => void;
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
  const progress = options.onProgress ?? ((msg: string) => console.log(msg));

  // 1. Generate fingerprint and compare with cached
  progress("[1/7] Generating fingerprint...");
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
  progress("[2/7] Detecting languages...");
  const registry = createRegistry();
  const detected = await registry.detectAll(repoRoot);
  if (detected.length === 0) {
    warnings.push("No supported languages detected");
  }

  // 3. Doctor check — bootstrap if tools are missing, then recheck
  progress("[3/7] Running doctor checks...");
  const activeLangs: string[] = [];
  for (const { lang } of detected) {
    const adapter = registry.getLanguageAdapter(lang)!;
    let doc = await adapter.doctor();
    if (!doc.ok) {
      // Attempt auto-bootstrap
      warnings.push(
        `${lang}: missing tools [${doc.missing_tools.join(", ")}], attempting bootstrap...`,
      );
      try {
        const bsResult = await adapter.bootstrap();
        if (bsResult.installed.length > 0) {
          warnings.push(
            `${lang}: bootstrap installed [${bsResult.installed.join(", ")}]`,
          );
        }
        for (const f of bsResult.failed) {
          warnings.push(`${lang}: bootstrap failed for ${f.tool}: ${f.reason}`);
        }
        // Re-check after bootstrap
        doc = await adapter.doctor();
      } catch (e) {
        warnings.push(`${lang}: bootstrap error: ${e}`);
      }
    }
    if (doc.ok) {
      activeLangs.push(lang);
    } else {
      warnings.push(
        `Skipping ${lang}: missing tools [${doc.missing_tools.join(", ")}]`,
      );
    }
  }

  // 4. Enumerate units for all active languages (track per-lang ownership)
  progress("[4/7] Enumerating units...");
  const unitEntries = await Promise.all(
    activeLangs.map(async (lang): Promise<[string, Unit[]]> => {
      const adapter = registry.getLanguageAdapter(lang)!;
      try {
        return [lang, await adapter.enumerateUnits(repoRoot, profile)];
      } catch (e) {
        errors.push(`${lang}: enumerateUnits failed: ${e}`);
        return [lang, [] as Unit[]];
      }
    }),
  );
  const unitsByLang = new Map(unitEntries);

  // 5. Index units — collect deltas and apply to empty facts
  progress("[5/7] Indexing units...");
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

  // Build a set of unit IDs per lang for diagnose phase
  const unitIdsByLang = new Map<string, Set<string>>();
  for (const lang of activeLangs) {
    const langUnits = unitsByLang.get(lang) ?? [];
    unitIdsByLang.set(lang, new Set(langUnits.map((u) => u.id)));
    if (langUnits.length === 0) continue;
    const adapter = registry.getLanguageAdapter(lang)!;
    try {
      const delta = await adapter.indexUnits(langUnits, profile);
      facts = applyDelta(facts, delta);
    } catch (e) {
      errors.push(`${lang}: indexUnits failed: ${e}`);
    }
  }

  // 6. Diagnose
  progress("[6/7] Running diagnostics...");
  for (const lang of activeLangs) {
    const adapter = registry.getLanguageAdapter(lang)!;
    const ids = unitIdsByLang.get(lang)!;
    const langUnits = facts.units.filter((u) => ids.has(u.id));
    if (langUnits.length === 0) continue;
    try {
      // Pass already-computed deps to avoid redundant goList calls
      const langDeps = facts.deps.filter((d) => ids.has(d.from_unit_id));
      const diags = await adapter.diagnose(langUnits, profile, langDeps);
      facts.diagnostics.push(...diags);
    } catch (e) {
      warnings.push(`${lang}: diagnose failed: ${e}`);
    }
  }

  // 7. Persist
  progress("[7/7] Persisting facts and indexes...");
  await writeFactsJsonl(cacheDir, facts);
  // Invalidate in-process query cache after write (dynamic import to avoid circular dependency)
  const { clearFactsCache } = await import("./query.ts");
  clearFactsCache();
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

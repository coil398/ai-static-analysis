// insights skill — context preparation and query helpers for AI insights
//
// TypeScript is responsible only for:
//   1. loadInsightContext: assembling facts + source text for Claude to analyse
//   2. query* functions: reading and filtering cache/insights.json
//
// Actual AI analysis is performed by Claude itself when running analyze-insights.md.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Facts,
  Insights,
  IntentTag,
  Summary,
  BugSmell,
  PatternTag,
  NamingIssue,
} from "../core/schema/types.ts";
import { readFacts, readInsights } from "../core/storage/index.ts";

// --- Types ---

export interface InsightScope {
  unit_ids?: string[];
  symbol_ids?: string[];
  file_ids?: string[];
}

export interface InsightContext {
  facts: Facts;
  /** file_id → source text (only files within scope) */
  sources: Record<string, string>;
}

export interface InsightQueryOptions {
  repoRoot: string;
  cacheDir?: string;
  minConfidence?: number;
}

// --- Context loading ---

/**
 * Load facts and source text for the given scope.
 * Used by analyze-insights.md so Claude can read everything it needs.
 */
export async function loadInsightContext(opts: {
  repoRoot: string;
  cacheDir?: string;
  scope?: InsightScope;
}): Promise<InsightContext> {
  const cacheDir = opts.cacheDir ?? join(opts.repoRoot, "cache");
  const facts = await readFacts(cacheDir);
  if (!facts) {
    throw new Error(
      `No cached facts found. Run index-facts first. (cacheDir: ${cacheDir})`,
    );
  }

  // Determine which file_ids are in scope
  const scopedFileIds = resolveScopedFileIds(facts, opts.scope);

  // Read source for each file in scope
  const sources: Record<string, string> = {};
  await Promise.all(
    Array.from(scopedFileIds).map(async (fileId) => {
      const file = facts.files.find((f) => f.id === fileId);
      if (!file) return;
      const absPath = join(opts.repoRoot, file.path);
      try {
        sources[fileId] = await readFile(absPath, "utf-8");
      } catch {
        // File may have been deleted; skip silently
      }
    }),
  );

  return { facts, sources };
}

function resolveScopedFileIds(facts: Facts, scope?: InsightScope): Set<string> {
  if (!scope) {
    // No scope = all files
    return new Set(facts.files.map((f) => f.id));
  }

  const ids = new Set<string>();

  if (scope.file_ids) {
    for (const id of scope.file_ids) ids.add(id);
  }

  if (scope.unit_ids) {
    const unitSet = new Set(scope.unit_ids);
    for (const f of facts.files) {
      if (unitSet.has(f.unit_id)) ids.add(f.id);
    }
  }

  if (scope.symbol_ids) {
    const symSet = new Set(scope.symbol_ids);
    for (const s of facts.symbols) {
      if (symSet.has(s.id)) ids.add(s.decl.file_id);
    }
  }

  // If nothing was specified in scope, fall back to all files
  if (!scope.file_ids && !scope.unit_ids && !scope.symbol_ids) {
    for (const f of facts.files) ids.add(f.id);
  }

  return ids;
}

// --- Internal helper ---

async function loadInsightsOrThrow(opts: InsightQueryOptions): Promise<Insights> {
  const cacheDir = opts.cacheDir ?? join(opts.repoRoot, "cache");
  const insights = await readInsights(cacheDir);
  if (!insights) {
    throw new Error(
      `No cached insights found. Run analyze-insights first. (cacheDir: ${cacheDir})`,
    );
  }
  return insights;
}

// --- Query functions ---

export async function queryIntents(
  targetId: string | undefined,
  opts: InsightQueryOptions,
): Promise<IntentTag[]> {
  const insights = await loadInsightsOrThrow(opts);
  const minConf = opts.minConfidence ?? 0;
  return insights.intent_tags.filter(
    (t) =>
      t.meta.confidence >= minConf &&
      (targetId === undefined || t.target_id === targetId),
  );
}

export async function querySummaries(
  targetId: string | undefined,
  opts: InsightQueryOptions,
): Promise<Summary[]> {
  const insights = await loadInsightsOrThrow(opts);
  const minConf = opts.minConfidence ?? 0;
  return insights.summaries.filter(
    (s) =>
      s.meta.confidence >= minConf &&
      (targetId === undefined || s.target_id === targetId),
  );
}

export async function querySmells(
  filter: { fileId?: string; severity?: string } | undefined,
  opts: InsightQueryOptions,
): Promise<BugSmell[]> {
  const insights = await loadInsightsOrThrow(opts);
  const minConf = opts.minConfidence ?? 0;
  return insights.bug_smells.filter((b) => {
    if (b.meta.confidence < minConf) return false;
    if (filter?.fileId && b.file_id !== filter.fileId) return false;
    if (filter?.severity && b.severity !== filter.severity) return false;
    return true;
  });
}

export async function queryPatterns(
  pattern: string | undefined,
  opts: InsightQueryOptions,
): Promise<PatternTag[]> {
  const insights = await loadInsightsOrThrow(opts);
  const minConf = opts.minConfidence ?? 0;
  return insights.pattern_tags.filter(
    (p) =>
      p.meta.confidence >= minConf &&
      (pattern === undefined || p.pattern === pattern),
  );
}

export async function queryNaming(
  symbolId: string | undefined,
  opts: InsightQueryOptions,
): Promise<NamingIssue[]> {
  const insights = await loadInsightsOrThrow(opts);
  const minConf = opts.minConfidence ?? 0;
  return insights.naming_issues.filter(
    (n) =>
      n.meta.confidence >= minConf &&
      (symbolId === undefined || n.symbol_id === symbolId),
  );
}

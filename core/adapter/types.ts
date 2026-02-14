// Adapter interfaces — SPEC.md §8.1, §8.2

import type {
  Unit,
  FactsDelta,
  Diagnostic,
  IntentTag,
  Summary,
  BugSmell,
  PatternTag,
  NamingIssue,
} from "../schema/types.js";

// §8.1 detect() result
export interface DetectResult {
  supported: boolean;
  confidence: number; // 0..1
}

// §8.1 doctor() result
export interface DoctorResult {
  ok: boolean;
  missing_tools: string[];
  notes: string[];
}

// §8.2 action result
export interface ActionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number;
}

// §8.2 scope variants
export type Scope =
  | { kind: "repo" }
  | { kind: "unit"; unitId: string }
  | { kind: "files"; paths: string[] }
  | { kind: "paths"; globs: string[] };

// §8.1 LanguageAdapter
export interface LanguageAdapter {
  readonly lang: string;
  detect(repoRoot: string): Promise<DetectResult>;
  enumerateUnits(
    repoRoot: string,
    profile: Record<string, string>,
  ): Promise<Unit[]>;
  indexUnits(
    units: Unit[],
    profile: Record<string, string>,
  ): Promise<FactsDelta>;
  diagnose(
    units: Unit[],
    profile: Record<string, string>,
  ): Promise<Diagnostic[]>;
  doctor(): Promise<DoctorResult>;
}

// §8.3 InsightAdapter — AI-powered non-deterministic analysis
export interface InsightScope {
  unit_ids?: string[]; // analyze specific units (omit for all)
  symbol_ids?: string[]; // analyze specific symbols (omit for all)
  file_ids?: string[]; // analyze specific files (omit for all)
}

export interface InsightAdapter {
  readonly model: string; // model id used for analysis

  tagIntents(scope: InsightScope): Promise<IntentTag[]>;
  summarize(scope: InsightScope): Promise<Summary[]>;
  detectBugSmells(scope: InsightScope): Promise<BugSmell[]>;
  detectPatterns(scope: InsightScope): Promise<PatternTag[]>;
  reviewNaming(scope: InsightScope): Promise<NamingIssue[]>;
}

// §8.2 ActionAdapter
export interface ActionAdapter {
  readonly lang: string;
  format(
    scope: Scope,
    profile: Record<string, string>,
  ): Promise<ActionResult>;
  check(
    scope: Scope,
    profile: Record<string, string>,
  ): Promise<ActionResult>;
  test(
    scope: Scope,
    profile: Record<string, string>,
  ): Promise<ActionResult>;
}

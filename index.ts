// Root barrel export for ai-static-analysis

// Core schema types
export type {
  Fingerprint,
  Position,
  Unit,
  File,
  Dep,
  Symbol,
  Ref,
  Diagnostic,
  TypeRelation,
  CallEdge,
  Facts,
  FactsDelta,
  InsightMeta,
  IntentTag,
  Summary,
  BugSmell,
  PatternTag,
  NamingIssue,
  DuplicationHint,
  Insights,
} from "./core/schema/index.ts";

// Core adapter
export type {
  LanguageAdapter,
  ActionAdapter,
  InsightAdapter,
  InsightScope,
  DetectResult,
  DoctorResult,
  ActionResult,
  Scope,
} from "./core/adapter/index.ts";
export { AdapterRegistry } from "./core/adapter/index.ts";

// Core storage
export {
  readFacts,
  writeFacts,
  writeFactsJsonl,
  readFingerprint,
  writeFingerprint,
  readInsights,
  writeInsights,
} from "./core/storage/index.ts";

// Core diff
export { applyDelta, impactUnits } from "./core/diff/index.ts";

// Core fingerprint
export {
  generateFingerprint,
  compareFingerprint,
  wipeCache,
} from "./core/fingerprint/index.ts";
export type { CompareResult } from "./core/fingerprint/index.ts";

// Core indexes
export {
  buildIndexes,
  loadUnitByFile,
  loadSymbolByName,
  loadRefsBySymbol,
} from "./core/index/index.ts";

// Skills
export { indexFacts } from "./skills/index.ts";
export type { IndexOptions, IndexResult } from "./skills/index.ts";

export { updateFacts } from "./skills/update.ts";
export type { UpdateOptions, UpdateResult } from "./skills/update.ts";

export { clearFactsCache } from "./skills/query.ts";

export {
  queryDeps,
  queryRdeps,
  queryDefs,
  queryRefs,
  queryDiagnostics,
  queryImpact,
  queryImpls,
  queryCallers,
  queryCallees,
  queryDeadCode,
} from "./skills/query.ts";
export type {
  QueryOptions,
  DepsResult,
  RdepsResult,
  DefsResult,
  RefsResult,
  DiagnosticsResult,
  ImpactResult,
  ImplsResult,
  CallersResult,
  CalleesResult,
  DeadCodeResult,
} from "./skills/query.ts";

export { runAction } from "./skills/actions.ts";
export type { ActionOptions, ActionRunResult } from "./skills/actions.ts";

export { bootstrapTools } from "./skills/bootstrap.ts";
export type {
  BootstrapOptions,
  BootstrapAllResult,
} from "./skills/bootstrap.ts";

export {
  loadInsightContext,
  queryIntents,
  querySummaries,
  querySmells,
  queryPatterns,
  queryNaming,
  queryDuplicationHints,
} from "./skills/insights.ts";
export type {
  InsightContext,
  InsightQueryOptions,
} from "./skills/insights.ts";

// Registry
export { createRegistry } from "./skills/registry.ts";

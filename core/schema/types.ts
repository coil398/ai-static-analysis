// P0 Data Model — SPEC.md §4-6

// §4.1 Fingerprint
export interface Fingerprint {
  schema_version: number;
  tools: Record<string, string>;
  build_profile: Record<string, string>;
  repo_state: {
    commit: string;
    working_tree_hash?: string;
  };
  created_at: string;
}

// Shared position type
export interface Position {
  line: number;
  column: number;
  byte_offset?: number;
}

// §6.2 Unit
export interface Unit {
  id: string;
  kind: string;
  name: string;
  path: string;
  metadata?: Record<string, unknown>;
}

// §6.3 File
export interface File {
  id: string;
  path: string;
  unit_id: string;
  hash: string;
  generated: boolean;
}

// §6.4 Dep
export interface Dep {
  from_unit_id: string;
  to_unit_id: string;
  kind: string;
}

// §6.5 Symbol
export interface Symbol {
  id: string;
  unit_id: string;
  name: string;
  kind: string;
  signature?: string;
  exported: boolean;
  decl: {
    file_id: string;
    position: Position;
  };
  metadata?: Record<string, unknown>;
}

// §6.6 Ref
export interface Ref {
  from_symbol_id: string;
  to_symbol_id: string;
  site: {
    file_id: string;
    position: Position;
  };
  kind: string;
  confidence: "certain" | "probable" | "speculative";
}

// §6.8 TypeRelation
export interface TypeRelation {
  from_type_id: string; // symbol id of the source type
  to_type_id: string; // symbol id of the target type
  kind: "implements" | "embeds" | "converts_to" | "instantiates";
}

// §6.9 CallEdge
export interface CallEdge {
  caller_id: string; // symbol id of the calling function
  callee_id: string; // symbol id of the called function
  site: {
    file_id: string;
    position: Position;
  };
  dispatch: "static" | "dynamic" | "interface";
}

// §6.7 Diagnostic
export interface Diagnostic {
  file_id: string;
  position: Position;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  tool: string;
}

// §6.1 Top-level Facts
export interface Facts {
  schema_version: number;
  snapshot: {
    commit: string;
    created_at: string;
  };
  units: Unit[];
  files: File[];
  deps: Dep[];
  symbols: Symbol[];
  refs: Ref[];
  type_relations: TypeRelation[];
  call_edges: CallEdge[];
  diagnostics: Diagnostic[];
  meta?: {
    generator?: string;
    notes?: string;
  };
}

// --- AI Insights (non-deterministic) — SPEC.md §14 ---
// Stored separately from Facts (cache/insights.json), never mixed with deterministic data.

// §14.1 Common metadata for all AI-generated insights
export interface InsightMeta {
  model: string; // model id that generated this insight (e.g. "claude-sonnet-4-5-20250929")
  confidence: number; // 0..1
  generated_at: string; // ISO 8601
}

// §14.2 Intent tagging — "this function is an auth guard", "this module is a repository"
export interface IntentTag {
  target_id: string; // symbol_id or unit_id
  target_kind: "symbol" | "unit";
  intent: string; // freeform label (e.g. "auth-guard", "repository-pattern", "error-handler")
  reasoning: string; // one-line justification
  meta: InsightMeta;
}

// §14.3 Summary — natural language description of a symbol or unit
export interface Summary {
  target_id: string;
  target_kind: "symbol" | "unit" | "file";
  text: string; // 1-3 sentence summary
  meta: InsightMeta;
}

// §14.4 Bug smell — suspicious patterns that deterministic tools miss
export interface BugSmell {
  file_id: string;
  position: Position;
  smell:
    | "swallowed_error"
    | "nil_check_missing"
    | "race_condition"
    | "resource_leak"
    | "unchecked_cast"
    | "logic_error"
    | "other";
  message: string;
  severity: "high" | "medium" | "low";
  meta: InsightMeta;
}

// §14.5 Design pattern detection
export interface PatternTag {
  target_id: string; // unit_id or symbol_id
  target_kind: "symbol" | "unit";
  pattern: string; // e.g. "factory", "observer", "repository", "singleton", "adapter"
  participants: string[]; // related symbol/unit ids
  meta: InsightMeta;
}

// §14.6 Naming quality
export interface NamingIssue {
  symbol_id: string;
  issue:
    | "misleading"
    | "too_abbreviated"
    | "inconsistent"
    | "too_generic"
    | "other";
  current_name: string;
  suggestion?: string;
  message: string;
  meta: InsightMeta;
}

// §14.7 Top-level Insights container
export interface Insights {
  schema_version: number;
  snapshot: {
    commit: string;
    created_at: string;
  };
  intent_tags: IntentTag[];
  summaries: Summary[];
  bug_smells: BugSmell[];
  pattern_tags: PatternTag[];
  naming_issues: NamingIssue[];
}

// Diff delta for incremental updates (§7.1)
export interface FactsDelta {
  added: {
    units?: Unit[];
    files?: File[];
    deps?: Dep[];
    symbols?: Symbol[];
    refs?: Ref[];
    type_relations?: TypeRelation[];
    call_edges?: CallEdge[];
    diagnostics?: Diagnostic[];
  };
  removed: {
    units?: string[];
    files?: string[];
    deps?: Array<{ from_unit_id: string; to_unit_id: string }>;
    symbols?: string[];
    refs?: Array<{ from_symbol_id: string; to_symbol_id: string }>;
    type_relations?: Array<{ from_type_id: string; to_type_id: string }>;
    call_edges?: Array<{ caller_id: string; callee_id: string }>;
    diagnostics?: Array<{ file_id: string; position: Position; message: string }>;
  };
}

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

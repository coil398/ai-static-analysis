// Adapter interfaces — SPEC.md §8.1, §8.2

import type {
  Unit,
  Dep,
  FactsDelta,
  Diagnostic,
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

// §8.1 bootstrap() result
export interface BootstrapResult {
  installed: string[]; // tools successfully installed
  failed: Array<{ tool: string; reason: string }>; // tools that failed
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
    deps?: Dep[],
  ): Promise<Diagnostic[]>;
  doctor(): Promise<DoctorResult>;
  bootstrap(): Promise<BootstrapResult>;
}

// §8.2 ActionAdapter
export interface ActionAdapter {
  readonly lang: string;
  format(
    repoRoot: string,
    scope: Scope,
    profile: Record<string, string>,
  ): Promise<ActionResult>;
  check(
    repoRoot: string,
    scope: Scope,
    profile: Record<string, string>,
  ): Promise<ActionResult>;
  test(
    repoRoot: string,
    scope: Scope,
    profile: Record<string, string>,
  ): Promise<ActionResult>;
}

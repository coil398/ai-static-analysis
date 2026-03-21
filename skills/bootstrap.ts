// bootstrap skill — install required tools for all detected languages

import type { BootstrapResult } from "../core/adapter/types.ts";
import { createRegistry } from "./registry.ts";

export interface BootstrapOptions {
  repoRoot: string;
}

export interface BootstrapAllResult {
  ok: boolean;
  results: Record<string, BootstrapResult>;
  errors: string[];
}

export async function bootstrapTools(
  options: BootstrapOptions,
): Promise<BootstrapAllResult> {
  const { repoRoot } = options;
  const registry = createRegistry();
  const errors: string[] = [];

  // Detect supported languages
  const detected = await registry.detectAll(repoRoot);
  if (detected.length === 0) {
    return { ok: false, results: {}, errors: ["No supported languages detected"] };
  }

  const results: Record<string, BootstrapResult> = {};

  for (const { lang } of detected) {
    const adapter = registry.getLanguageAdapter(lang)!;
    try {
      results[lang] = await adapter.bootstrap();
    } catch (e) {
      errors.push(`${lang}: bootstrap failed: ${e}`);
      results[lang] = { installed: [], failed: [], notes: [`bootstrap error: ${e}`] };
    }
  }

  return {
    ok: errors.length === 0,
    results,
    errors,
  };
}

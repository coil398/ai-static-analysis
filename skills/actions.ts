// run-actions skill — execute format/check/test actions

import type { Scope, ActionResult } from "../core/adapter/types.ts";
import { createRegistry } from "./registry.ts";

export interface ActionOptions {
  repoRoot: string;
  action: "format" | "check" | "test";
  scope: Scope;
  profile?: Record<string, string>;
}

export interface ActionRunResult {
  ok: boolean;
  results: Array<{
    lang: string;
    action: string;
    result: ActionResult;
  }>;
  errors: string[];
}

export async function runAction(
  options: ActionOptions,
): Promise<ActionRunResult> {
  const { repoRoot, action, scope, profile = {} } = options;
  const errors: string[] = [];
  const results: ActionRunResult["results"] = [];

  // 1. Detect languages
  const registry = createRegistry();
  const detected = await registry.detectAll(repoRoot);

  // 2. Run action for each language that has an ActionAdapter
  for (const { lang } of detected) {
    const adapter = registry.getActionAdapter(lang);
    if (!adapter) {
      continue;
    }

    try {
      let result: ActionResult;
      switch (action) {
        case "format":
          result = await adapter.format(scope, profile);
          break;
        case "check":
          result = await adapter.check(scope, profile);
          break;
        case "test":
          result = await adapter.test(scope, profile);
          break;
      }
      results.push({ lang, action, result });
    } catch (e) {
      errors.push(`${lang}: ${action} failed: ${e}`);
    }
  }

  const ok = errors.length === 0 && results.every((r) => r.result.ok);
  return { ok, results, errors };
}

// Adapter registry + dispatcher — SPEC.md §3

import type { LanguageAdapter, ActionAdapter } from "./types.js";

export class AdapterRegistry {
  private languageAdapters = new Map<string, LanguageAdapter>();
  private actionAdapters = new Map<string, ActionAdapter>();

  register(adapter: LanguageAdapter, actionAdapter?: ActionAdapter): void {
    this.languageAdapters.set(adapter.lang, adapter);
    if (actionAdapter) {
      this.actionAdapters.set(actionAdapter.lang, actionAdapter);
    }
  }

  async detectAll(
    repoRoot: string,
  ): Promise<Array<{ lang: string; confidence: number }>> {
    const results: Array<{ lang: string; confidence: number }> = [];

    for (const adapter of this.languageAdapters.values()) {
      const result = await adapter.detect(repoRoot);
      if (result.supported) {
        results.push({ lang: adapter.lang, confidence: result.confidence });
      }
    }

    results.sort((a, b) => b.confidence - a.confidence);
    return results;
  }

  getLanguageAdapter(lang: string): LanguageAdapter | undefined {
    return this.languageAdapters.get(lang);
  }

  getActionAdapter(lang: string): ActionAdapter | undefined {
    return this.actionAdapters.get(lang);
  }

  getAll(): LanguageAdapter[] {
    return [...this.languageAdapters.values()];
  }
}

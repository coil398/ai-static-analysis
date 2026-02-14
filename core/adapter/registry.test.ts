import { describe, it, expect } from "bun:test";
import { AdapterRegistry } from "./registry.js";
import type {
  LanguageAdapter,
  ActionAdapter,
  DetectResult,
  DoctorResult,
} from "./types.js";
import type { Unit, FactsDelta, Diagnostic } from "../schema/types.js";

function mockLanguageAdapter(
  lang: string,
  detectResult: DetectResult,
): LanguageAdapter {
  return {
    lang,
    detect: async () => detectResult,
    enumerateUnits: async () => [] as Unit[],
    indexUnits: async () => ({ added: {}, removed: {} }) as FactsDelta,
    diagnose: async () => [] as Diagnostic[],
    doctor: async () =>
      ({ ok: true, missing_tools: [], notes: [] }) as DoctorResult,
  };
}

function mockActionAdapter(lang: string): ActionAdapter {
  const result = { ok: true, stdout: "", stderr: "", exit_code: 0 };
  return {
    lang,
    format: async () => result,
    check: async () => result,
    test: async () => result,
  };
}

describe("AdapterRegistry", () => {
  it("register and get language adapter", () => {
    const registry = new AdapterRegistry();
    const adapter = mockLanguageAdapter("go", {
      supported: true,
      confidence: 1,
    });
    registry.register(adapter);

    expect(registry.getLanguageAdapter("go")).toBe(adapter);
  });

  it("register and get action adapter", () => {
    const registry = new AdapterRegistry();
    const langAdapter = mockLanguageAdapter("go", {
      supported: true,
      confidence: 1,
    });
    const actAdapter = mockActionAdapter("go");
    registry.register(langAdapter, actAdapter);

    expect(registry.getActionAdapter("go")).toBe(actAdapter);
  });

  it("returns undefined for unregistered language", () => {
    const registry = new AdapterRegistry();

    expect(registry.getLanguageAdapter("rust")).toBeUndefined();
    expect(registry.getActionAdapter("rust")).toBeUndefined();
  });

  it("detectAll returns supported adapters sorted by confidence desc", async () => {
    const registry = new AdapterRegistry();
    registry.register(
      mockLanguageAdapter("python", { supported: true, confidence: 0.5 }),
    );
    registry.register(
      mockLanguageAdapter("go", { supported: true, confidence: 0.9 }),
    );
    registry.register(
      mockLanguageAdapter("ruby", { supported: false, confidence: 0 }),
    );
    registry.register(
      mockLanguageAdapter("typescript", { supported: true, confidence: 0.7 }),
    );

    const results = await registry.detectAll("/repo");

    expect(results).toEqual([
      { lang: "go", confidence: 0.9 },
      { lang: "typescript", confidence: 0.7 },
      { lang: "python", confidence: 0.5 },
    ]);
  });

  it("detectAll returns empty array when no adapters registered", async () => {
    const registry = new AdapterRegistry();
    const results = await registry.detectAll("/repo");
    expect(results).toEqual([]);
  });

  it("getAll returns all registered language adapters", () => {
    const registry = new AdapterRegistry();
    const goAdapter = mockLanguageAdapter("go", {
      supported: true,
      confidence: 1,
    });
    const tsAdapter = mockLanguageAdapter("typescript", {
      supported: true,
      confidence: 1,
    });
    registry.register(goAdapter);
    registry.register(tsAdapter);

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all).toContain(goAdapter);
    expect(all).toContain(tsAdapter);
  });
});

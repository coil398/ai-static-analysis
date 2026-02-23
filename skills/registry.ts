// Adapter registry bootstrap — register all known adapters

import { AdapterRegistry } from "../core/adapter/index.ts";
import { GoLanguageAdapter, GoActionAdapter } from "../adapters/go/index.ts";

export function createRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new GoLanguageAdapter(), new GoActionAdapter());
  return registry;
}

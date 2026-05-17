// Adapter registry bootstrap — register all known adapters

import { AdapterRegistry } from "../core/adapter/index.ts";
import { GoLanguageAdapter, GoActionAdapter } from "../adapters/go/index.ts";
import { TypeScriptLanguageAdapter, TypeScriptActionAdapter } from "../adapters/typescript/index.ts";
import { PythonLanguageAdapter, PythonActionAdapter } from "../adapters/python/index.ts";
import { CSharpLanguageAdapter, CSharpActionAdapter } from "../adapters/csharp/index.ts";
import { RustLanguageAdapter, RustActionAdapter } from "../adapters/rust/index.ts";
import { JavaLanguageAdapter, JavaActionAdapter } from "../adapters/java/index.ts";
import { CppLanguageAdapter, CppActionAdapter } from "../adapters/cpp/index.ts";
import { HaskellLanguageAdapter, HaskellActionAdapter } from "../adapters/haskell/index.ts";
import { ClojureLanguageAdapter, ClojureActionAdapter } from "../adapters/clojure/index.ts";
import { ElixirLanguageAdapter, ElixirActionAdapter } from "../adapters/elixir/index.ts";

export function createRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new GoLanguageAdapter(), new GoActionAdapter());
  registry.register(new TypeScriptLanguageAdapter(), new TypeScriptActionAdapter());
  registry.register(new PythonLanguageAdapter(), new PythonActionAdapter());
  registry.register(new CSharpLanguageAdapter(), new CSharpActionAdapter());
  registry.register(new RustLanguageAdapter(), new RustActionAdapter());
  registry.register(new JavaLanguageAdapter(), new JavaActionAdapter());
  registry.register(new CppLanguageAdapter(), new CppActionAdapter());
  registry.register(new HaskellLanguageAdapter(), new HaskellActionAdapter());
  registry.register(new ClojureLanguageAdapter(), new ClojureActionAdapter());
  registry.register(new ElixirLanguageAdapter(), new ElixirActionAdapter());
  return registry;
}

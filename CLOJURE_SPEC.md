# Clojure アダプタ仕様 (CLOJURE_SPEC.md)

本書は Clojure 言語アダプタ固有の仕様を定義する。共通インターフェースは SPEC.md §8 を参照。

---

## 1. 使用ツール

| ツール | 用途 | 必須 |
|---|---|---|
| `java` (JDK 11+) | ランタイム | MUST |
| `clojure` / `clj` | tools.deps build driver | SHOULD |
| `lein` | Leiningen build driver | SHOULD（project.clj プロジェクト向け） |
| `clojure-lsp` | symbols/refs/call_edges (LSP) | SHOULD |
| `clj-kondo` | 静的解析（diagnose、clojure-lsp 内に同梱もあり） | MAY |
| `cljfmt` / `zprint` | フォーマッタ | MAY |

clojure-lsp は native static binary（GraalVM ネイティブイメージ）が配布されており、JVM 起動コストなしで使える。`clojure-lsp 2025+` 推奨。

---

## 2. Unit マッピング

プロジェクトルート（`deps.edn` / `project.clj` / `shadow-cljs.edn` / `bb.edn` / `build.boot` のいずれかを持つディレクトリ）が unit。深さ 3 まで再帰的に探索し、サブプロジェクトを発見する（polylith / monorepo 対応）。

```
Unit {
  id:   "unit:clojure:<relPath>"     // root は "unit:clojure:."
  kind: "clojure_project"
  name: "<dir_basename>"
  path: "<relPath>"
  metadata: {
    repo_root: "<absPath>"
    marker: "deps.edn" | "project.clj" | ...
    source_paths: ["src", ...]   // deps.edn :paths / project.clj :source-paths から抽出
  }
}
```

`.clj/.cljs/.cljc` だけがあってマーカーが無いリポでは `unit:clojure:.` にフォールバック。

---

## 3. ID 規約

- Unit: `unit:clojure:<relPath>` （root は `unit:clojure:.`）
- File: `file:<relPath>`
- Symbol: `sym:clojure:<unit_path>#<kind>#<name>#sig:<hash>`
- Symbol kind: `namespace` / `function` / `var` / `constant` / `type`

---

## 4. 依存解決

`(:require ...)` / `(:use ...)` から namespace を抽出し、ファイル内 `(ns ...)` で宣言されたモジュールマップ（namespace → unit_id）と照合して unit deps を生成（kind=`require`）。

```clojure
(ns myapp.app.main
  (:require [myapp.lib.greet :as g]      ; ← Foo.Bar をキャプチャ
            [clojure.string :refer [join]]
            myapp.lib.util))             ; ← bare-symbol 形式もサポート
```

- `[Foo.{Bar, Baz}]` 形式ではないため Elixir のような brace 展開は不要
- `clojure.*` / `clojure.string` 等の built-in は unit map に存在しないため自動的にドロップ

`extractSourcePaths` は `:paths`（deps.edn）/ `:source-paths`（project.clj）/ `:source-paths #{...}`（boot）を読み取る。マッチしなければ `["src"]` をデフォルトとする。

---

## 5. シンボル抽出（clojure-lsp）

- `textDocument/documentSymbol` を再帰的にフラット化
- `CLOJURE_SYMBOL_KIND_MAP` で LSP `SymbolKind` を Clojure kind にマップ
- `defn-` などの private 修飾は documentSymbol では取れないため LSP 経由は `exported: true` 固定
- パーサフォールバック（LSP 未導入時）は `defn-` 名前にダッシュが含まれるかで `exported` を判定

### refs / call_edges

| 出力 | LSP メソッド |
|---|---|
| `refs`（call） | `prepareCallHierarchy` + `outgoingCalls` の `fromRanges` |
| `call_edges` | 同上、`dispatch: "dynamic"`（Clojure は動的ディスパッチ） |
| `refs`（reference） | `references` を var/function/constant に発行 |

`type_relations` は出力しない（Clojure は class-based ではないため）。protocols / multimethods への対応は将来検討。

---

## 6. Diagnostics

| ツール | 検出内容 | 条件 |
|---|---|---|
| `detectCyclicDeps`（内蔵） | unit 間の循環依存 | 常時 |
| `clj-kondo` | linter（unused / arity-mismatch 等） | `clj-kondo` が PATH にあり、`{:output {:format :json}}` を受け付ける |

clojure-lsp は内部で clj-kondo を呼び出すため、`clojure-lsp` だけ入っていれば clj-kondo を直接インストールしなくても動く。

---

## 7. Bootstrap

OS / 環境依存のため自動インストールは試みない。`notes` で以下を案内:

- JDK: OS の package manager または sdkman
- Clojure CLI: https://clojure.org/guides/install_clojure
- clojure-lsp: https://github.com/clojure-lsp/clojure-lsp/releases （native static binary）
- clj-kondo: https://github.com/clj-kondo/clj-kondo/releases

---

## 8. Actions

| action | コマンド |
|---|---|
| `format` | `cljfmt fix` → `zprint -w` fallback |
| `check` | `clj-kondo --lint .` → `clojure -M:check` → `lein check` fallback |
| `test` | deps.edn なら `clojure -X:test`、project.clj なら `lein test` |

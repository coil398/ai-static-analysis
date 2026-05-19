# Elixir アダプタ仕様 (ELIXIR_SPEC.md)

本書は Elixir 言語アダプタ固有の仕様を定義する。共通インターフェースは SPEC.md §8 を参照。

---

## 1. 使用ツール

| ツール | 用途 | 必須 |
|---|---|---|
| `elixir` / `mix` | ランタイム + build driver | MUST |
| `elixir-ls` または `language_server.sh` | symbols/refs/call_edges (LSP) | SHOULD |
| `credo` | 静的解析（diagnose） | MAY |
| `mix format` | フォーマッタ（標準ツール） | MAY |

elixir-ls は LSP-backed の symbols/refs を取得するために**プロジェクトのコンパイル**を要求する。`mix deps.get && mix compile` が走っていない testdata では `documentSymbol` が `[]` を返す。アダプタはその場合パーサベースのフォールバックに自動切り替えする。

---

## 2. Unit マッピング

- 単一プロジェクト（`mix.exs` のみ） → `unit:elixir:.`
- Umbrella プロジェクト（`apps/` ディレクトリの各サブディレクトリに `mix.exs`） → `unit:elixir:apps/<app_name>`

```
Unit {
  id:   "unit:elixir:<relPath>"
  kind: "elixir_app"
  name: "<app_name>"  // umbrella ではディレクトリ名
  path: "<relPath>"
  metadata: {
    repo_root: "<absPath>"
    source_dirs: ["lib", "test"]
  }
}
```

`.ex/.exs` だけがあって `mix.exs` が無い場合は `unit:elixir:.` にフォールバック（test 用途想定）。

---

## 3. ID 規約

- Unit: `unit:elixir:<relPath>` （単一は `unit:elixir:.`）
- File: `file:<relPath>`
- Symbol: `sym:elixir:<unit_path>#<kind>#<name>#sig:<hash>`
- Symbol kind: `module` / `namespace` / `function` / `macro` / `struct` / `variable` / `constant`

---

## 4. 依存解決

`defmodule` でモジュール名を収集し、ファイル内の `alias` / `import` / `use` / `require` から得たモジュール参照を unit_id に逆引きする（kind=`alias`）。

```elixir
defmodule X do
  alias Foo.Bar
  alias Foo.{Baz, Qux}    # → Foo.Baz, Foo.Qux に展開
  import Logger
  use GenServer
  require Logger
end
```

- `Foo.{Bar, Baz}` 形式は `parseModuleReferences` で個別 namespace に展開
- 外部依存（`GenServer`、`Logger` 等）は unit map に存在しないため自動的にドロップ
- 同一 unit 内の参照は出力しない

---

## 5. シンボル抽出（elixir-ls）

- `textDocument/documentSymbol` を再帰的にフラット化
- `ELIXIR_SYMBOL_KIND_MAP` で LSP `SymbolKind` を Elixir kind にマップ
- `def` / `defp` の区別は documentSymbol では取得できないため `exported: true` 固定（パーサフォールバックでは正しく `false` を返す）

### パーサフォールバック

elixir-ls が空配列を返した場合（プロジェクト未コンパイル / LSP クラッシュ）、`parseTopLevelDefs` でモジュール + def/defp/defmacro/defmacrop を抽出する。`defp` / `defmacrop` は `exported: false`。

### refs / call_edges

| 出力 | LSP メソッド |
|---|---|
| `refs`（call） | `prepareCallHierarchy` + `outgoingCalls` の `fromRanges` |
| `call_edges` | 同上、`dispatch: "dynamic"` |
| `refs`（type_ref） | `references` を module/namespace/struct に発行 |
| `refs`（reference） | `references` を function に発行 |

`type_relations`: パーサベースで `@behaviour <Module>` 属性と `defimpl <Protocol>, for: <Type>` ブロックを解析し、`kind: "implements"` の TypeRelation を生成する。`parseBehaviourRelations` 関数で実装。LSP 結果の有無に関わらず常にマージされる。`defimpl` の実装型は `kind: "class"` の Symbol としても追加される。

---

## 6. Diagnostics

| ツール | 検出内容 | 条件 |
|---|---|---|
| `detectCyclicDeps`（内蔵） | unit 間の循環依存 | 常時 |
| `credo` | スタイル / readability / refactoring の警告 | `mix credo --format=json` が動く場合 |

`mix credo` は `mix.exs` に credo が依存として宣言されている必要がある。導入されていなければ JSON 出力が空 / エラーになるため、`parseCredoJson` は壊れた JSON を空配列として扱う。

---

## 7. Bootstrap

OS / 環境依存のため自動インストールは試みない。`notes` で以下を案内:

- `apt install elixir` / `brew install elixir`
- elixir-ls: https://github.com/elixir-lsp/elixir-ls/releases （`language_server.sh` を PATH に置く）
- credo: `mix archive.install hex credo`

---

## 8. Actions

| action | コマンド |
|---|---|
| `format` | `mix format` |
| `check` | `mix compile --warnings-as-errors` |
| `test` | `mix test` |

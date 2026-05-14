# Haskell アダプタ仕様 (HASKELL_SPEC.md)

本書は Haskell 言語アダプタ固有の仕様を定義する。共通インターフェースは SPEC.md §8 を参照。

---

## 1. 使用ツール

| ツール | 用途 | 必須 |
|---|---|---|
| `ghc` | コンパイラ | MUST |
| `cabal` または `stack` | ビルドドライバ | SHOULD |
| `haskell-language-server-wrapper` / `haskell-language-server` | symbols/refs/call_edges (LSP) | SHOULD |
| `hlint` | 静的解析（diagnose） | MAY |
| `ormolu` / `fourmolu` | フォーマッタ | MAY |

HLS は GHC のバージョンと厳密に紐づく。OS 配布の `ghc` パッケージとは合わないことが多いため、ローカルでは `ghcup install ghc <version>` と `ghcup install hls <version>` で揃えるか、CI では `haskell-actions/setup` を使う。バージョンが噛み合わない場合 HLS 起動時に「libHS...so not found」で死ぬ — アダプタは catch して空配列に degrade する。

---

## 2. Unit マッピング

`.cabal` ファイルの各スタンザ（`library` / `executable` / `test-suite` / `benchmark`）が unit。

```
Unit {
  id:   "unit:haskell:<stanza-kind>:<name>"
  kind: "haskell_library" | "haskell_executable" | "haskell_test_suite" | "haskell_benchmark"
  name: "<stanza-name>"   // library のデフォルト名は "library"
  path: "<first hs-source-dir>"
  metadata: {
    repo_root: "<absPath>"
    stanza: "library" | "executable" | "test-suite" | "benchmark"
    hs_source_dirs: ["src", ...]
    build_depends: ["base", "text", ...]
  }
}
```

`.cabal` が無い / 解析できない場合は `unit:haskell:.` にフォールバック。

---

## 3. ID 規約

- Unit: `unit:haskell:<stanza-kind>:<name>` （fallback は `unit:haskell:.`）
- File: `file:<relPath>`
- Symbol: `sym:haskell:<unit_path>#<kind>#<name>#sig:<hash>`
- Symbol kind: `module` / `function` / `class` / `interface`（type class）/ `type` / `variable` / `constant`

---

## 4. 依存解決

### import ベース

- `^\s*import (qualified)? <Module>(.*)$` を抽出
- `(:as ...)` / `(:hiding (...))` は無視
- モジュール名（例: `Lib.Greet`）を `inferModuleName(relPath, hsSourceDir)` で逆引きし、`<unit_id>` に解決

### build-depends ベース

- 同一 cabal パッケージ内の cross-stanza 依存（例: executable が library に依存）を `kind: "build-depends"` で出力
- 外部パッケージ（`base`、`text` 等）は unit ID として存在しないため自動的にドロップ

---

## 5. シンボル抽出（HLS）

- `textDocument/documentSymbol` を再帰的にフラット化
- HASKELL_SYMBOL_KIND_MAP で LSP `SymbolKind` を Haskell kind にマップ
- 公開モジュールヘッダ（`module M (a, b) where`）は documentSymbol では出ないため `exported: true` 固定

### refs / call_edges / type_relations

| 出力 | LSP メソッド |
|---|---|
| `refs`（call） | `prepareCallHierarchy` + `outgoingCalls` の `fromRanges`（HLS 2.5+） |
| `call_edges` | 同上 |
| `refs`（type_ref / reference） | `references` を type/class/interface/function に発行 |
| `type_relations`（implements） | `textDocument/implementation` を class（type class）に発行 — type class 制約を満たす型を取得 |

HLS の callHierarchy / implementation サポートは 2.5 以降比較的安定。古い版を使う場合は空配列に degrade。

---

## 6. Diagnostics

| ツール | 検出内容 | 条件 |
|---|---|---|
| `detectCyclicDeps`（内蔵） | unit 間の循環依存 | 常時 |
| `hlint` | スタイル / バグ臭 | `hlint` が PATH にあり、JSON 出力（`--json`）を吐ける場合 |

---

## 7. Bootstrap

OS / 環境依存のため自動インストールは試みない。`notes` で以下を案内:

- `curl --proto =https --tlsv1.2 -sSf https://get-ghcup.haskell.org | sh`
- `ghcup install ghc recommended && ghcup install hls recommended && ghcup install cabal recommended`
- `cabal install hlint`

---

## 8. Actions

| action | コマンド |
|---|---|
| `format` | `fourmolu -i` → `ormolu -i` fallback、find で `.hs/.lhs` を流し込む |
| `check` | `cabal build all` → `stack build` fallback |
| `test` | `cabal test all` → `stack test` fallback |

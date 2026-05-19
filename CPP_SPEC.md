# C++ アダプタ仕様 (CPP_SPEC.md)

本書は C++ 言語アダプタ固有の仕様を定義する。共通インターフェースは SPEC.md §8 を参照。

---

## 1. 使用ツール

| ツール | 用途 | 必須 |
|---|---|---|
| `g++` / `clang++` / `c++` | C++ コンパイラ | MUST |
| `clangd` | symbols/refs/call_edges/type_relations (LSP) | SHOULD |
| `compile_commands.json` | clangd の信頼性向上 | SHOULD |
| `cmake` | ビルドドライバ / `compile_commands.json` 生成 | MAY |
| `cppcheck` | 静的解析（diagnose） | MAY |
| `clang-tidy` | 静的解析（diagnose） | MAY |
| `clang-format` | フォーマッタ | MAY |

clangd は `compile_commands.json` がリポジトリルートにあるとプロジェクト全体を解決できる。無い場合は単一ファイルモードで動作し、cross-file refs/call_edges は精度が落ちる。

---

## 2. Unit マッピング

トップレベルのソースディレクトリ（`.cpp/.cc/.cxx/.c++` を含むディレクトリ）が unit。`include/` は通常ヘッダーオンリーなので除外し、`#include` 解決経由で「最も関係の深い source unit」に紐づけられる。

```
Unit {
  id:   "unit:cpp:<relPath>"   // e.g. "unit:cpp:app"
  kind: "cpp_module"
  name: "<dir_basename>"
  path: "<relPath>"
  metadata: { repo_root: "<absPath>" }
}
```

ソースが平坦な単一ディレクトリ構成の場合は `unit:cpp:.` に collapse。

---

## 3. ID 規約

- Unit: `unit:cpp:<relPath>` （root は `unit:cpp:.`）
- File: `file:<relPath>`
- Symbol: `sym:cpp:<unit_path>#<kind>#<name>#sig:<hash>`
- Symbol kind: `class` / `struct` / `enum` / `function` / `method` / `constructor` / `field` / `constant` / `variable`（clangd の `SymbolKind` をマップ）

---

## 4. 依存解決

- ソース・ヘッダーの `#include "..."` を抽出（`<...>` のシステムインクルードは無視）
- 解決順:
  1. `dirname(source) + included` の相対パス（同ディレクトリ）
  2. `repoRoot + included` の絶対相対パス
  3. ヘッダー basename での fallback
- 解決先のヘッダーが所属する unit が `to_unit_id`、source の unit が `from_unit_id`、kind=`include`
- 同一 unit 内の include は出力しない

`include/` 配下のヘッダーは「同名 source（`greet.hpp` ↔ `greet.cpp`）を持つ source unit」に attribute する。なければ最初の unit にフォールバック。

---

## 5. シンボル抽出（clangd）

- `textDocument/documentSymbol` を再帰的にフラット化
- `CPP_SYMBOL_KIND_MAP` で LSP の `SymbolKind` を C++ kind にマップ
- access modifier は clangd の documentSymbol では取得できないため `exported: true` 固定

### refs / call_edges / type_relations

| 出力 | LSP メソッド |
|---|---|
| `call_edges` | `prepareCallHierarchy` + `outgoingCalls` |
| `refs`（call） | 上記の `fromRanges` |
| `refs`（type_ref） | `references` を class/struct/interface に発行 |
| `refs`（field_access） | `references` を field に発行 |
| `refs`（reference） | `references` を constant/variable に発行 |
| `type_relations`（implements） | `textDocument/implementation` を class/struct/interface に発行（基底クラス継承 / virtual override） |

`from_symbol_id` は参照位置を内包する method/constructor/function を `findEnclosingSymbol` で逆引きする。

---

## 6. Diagnostics

| ツール | 検出内容 | 条件 |
|---|---|---|
| `detectCyclicDeps`（内蔵） | unit 間の循環依存 | 常時 |
| `cppcheck` | warning / style / performance / portability | `cppcheck` が PATH にある場合 |
| `clang-tidy` | clang-analyzer-* / bugprone-* チェック | `clang-tidy` が PATH にある場合 |

clang-tidy の出力形式: `<file>:<line>:<col>: warning|error: <message> [<check-name>]`。`parseClangTidyOutput` 関数でパース。`note:` 行・repoRoot 外のファイルはスキップ。

---

## 7. Bootstrap

OS 依存のため自動インストールは試みない。`notes` で以下を案内:

- `apt install clangd clang-tidy clang-format` / `brew install llvm`
- `apt install cppcheck cmake` / `brew install cppcheck cmake`

---

## 8. Actions

| action | コマンド |
|---|---|
| `format` | `clang-format -i` 全 `.cpp/.cc/.hpp/.h` |
| `check` | `cmake --build build` （既存ビルドツリーがあれば再利用）→ Makefile fallback |
| `test` | `ctest --test-dir build --output-on-failure` → `make test` fallback |

# ai-static-analysis 残タスク7件 実装記録

_作成: 2026-05-19 | ステータス: 進行中_

## 目標

ai-static-analysis レポジトリの独立した残タスク7件を実装する:

- #5 setExternalLspClient 統一（TS/Python/Rust/C#）
- #4 Go interface dispatch 判定
- #6 E2E テスト多言語化（TS/Python/Rust/C#）
- #8 Java pmd / C++ clang-tidy 統合
- #9 Clojure/Elixir protocols/behaviours の type_relations
- #10 InsightAdapter 型定義の削除
- #11 CI カバレッジ計測

_ステータス: 完了（2026-05-19）_

## 実装計画

- [x] ステップ1 (#5): TS/Python/Rust/C# の4アダプタに setExternalLspClient 追加 + テスト
- [x] ステップ2 (#4): Go call_edges に interface dispatch 判定（interfaceSymbols 照合）+ GO_SPEC.md 更新
- [x] ステップ3 (#6): skills/e2e.test.ts を TS/Python/Rust/C# に拡張
- [x] ステップ4 (#8): Java diagnose に pmd、C++ diagnose に clang-tidy をオプション統合 + SPEC 更新
- [x] ステップ5 (#9): Clojure/Elixir の type_relations をパーサベースで抽出 + SPEC 更新
- [x] ステップ6 (#10): core/adapter/types.ts の InsightAdapter 型削除 + SPEC.md §8.3 更新
- [x] ステップ7 (#11): test.yml に coverage、bunfig.toml に coverage 設定追加
- [x] 各タスクで CLAUDE.md「実装状態」・README.md・該当 LANG_SPEC.md を更新

---

## 設計詳細

> 詳細プランは `{RUN_DIR}/plan.md`（PIR² run ディレクトリ内）に保存。以下は要点の転記。

### #5 setExternalLspClient 統一

既存6アダプタ（Go/Java/C++/Haskell/Clojure/Elixir）の共通パターンに厳密に倣う。各アダプタ5点変更: `private externalClient` フィールド追加 / `setExternalLspClient` メソッド追加 / `indexUnits` の client 生成を外部優先に変更 / `ownClient` フラグ追加 / `finally` の条件付き shutdown。Rust の `indexUnits` 直書き構造の切り出しリファクタは行わない（逸脱回避）。C# は `buildDotnetEnv()` の env 責務が注入側に移る点をコメントで明記。

### #4 Go interface dispatch 判定

採用方式: **案A（interfaceSymbols 照合・最小変更）**。phase 1 で収集済みの `interfaceSymbols` と callee の `metadata.receiver` を名前照合し、一致すれば `dispatch: "interface"`。追加 LSP 呼び出しゼロ、共通 LspClient 非変更。interface 変数経由呼び出し（`var x MyInterface = ...`）は捕捉できず既知の制限として GO_SPEC.md に明記。

### #6 E2E テスト多言語化

言語別 describe 方式（parameterized 不採用）で Go パターンを踏襲。TS/Python/Rust/C# の testdata（全言語に既存）を使い、LSP・ビルドツール依存部分は `test.skipIf` でガード。test.yml の timeout を 60→90分に延長。

### #8 Java pmd / C++ clang-tidy 統合

checkstyle / cppcheck の既存統合パターンに倣う。Java: `pmd check -d . -R <ruleset> -f json` + `parsePmdJson`、priority→severity マッピング。C++: `clang-tidy -checks=clang-analyzer-*,bugprone-*` + `parseClangTidyOutput`（stdout テキストパース、`<TOOL>_RE` 命名）。両方 PATH 未存在で graceful degrade。

### #9 Clojure/Elixir type_relations

clojure-lsp / elixir-ls は protocol/behaviour を返さないためパーサベースで抽出。Clojure: `defprotocol` / `defrecord` / `deftype` body の実装検出（multimethods は対象外）。Elixir: `@behaviour` 属性 + `defimpl ..., for: ...` 抽出、module 単位。いずれも `TypeRelation { kind: "implements" }`、`from`=実装型 / `to`=protocol/behaviour。

### #10 InsightAdapter 型削除

planner 決定 + ユーザー承認: **削除**（@deprecated 残置でなく）。`core/adapter/types.ts` の `InsightAdapter` インターフェース、`core/adapter/index.ts` とルート `index.ts` の export を削除。`InsightScope` / `IntentTag` 等の付随型は `skills/insights.ts` での実利用を grep 確認して残す。SPEC.md §8.3 / CLAUDE.md「設計判断」を「型定義も削除済み」に更新。

### #11 CI カバレッジ計測

test.yml の `bun test` に `--coverage --coverage-reporter=lcov` 追加 + coverage アーティファクトアップロード。bunfig.toml に coverage 設定（`coverageThreshold` は設定しない — 現状カバレッジ不明で CI 即 fail 回避）。package.json に `test:coverage` スクリプト。Codecov 連携なし（プライベートレポジトリ）。

---

## 実装ログ

### 実装完了（2026-05-19）

- 変更規模: 42 ファイル / +1272 / -99
- レビュー: reviewer 5観点ハイブリッド並列、INNER_LOOP_COUNT=2 で全 PASS
- テスト: tester 最小スコープ、OUTER_LOOP_COUNT=1（既存バグ顕在化による差し戻し1回）、最終 191 pass / 0 fail / 22 skip

### 実装ウォークスルー（フル版）

#### #5 setExternalLspClient 統一

TS/Python/Rust/C# の `adapters/<lang>/language-adapter.ts` に既存6アダプタと同一の外部 LSP クライアント注入機構を追加。`private externalClient` フィールド + `setExternalLspClient()` メソッド + `indexUnits` 内でのクライアント生成を `this.externalClient ?? new LspClient(...)` に変更し、`ownClient` フラグで自前生成時のみ `finally` で shutdown。C# は `buildDotnetEnv()` の env 責務が注入側に移る旨をコメントで明記。各 `language-adapter.test.ts` に注入テスト2件追加。これで全10アダプタが同一の注入インターフェースを持つ。

#### #4 Go interface dispatch 判定

`adapters/go/language-adapter.ts` の phase 2 call_edge 生成で、callee の `metadata.receiver` が phase 1 収集済みの `interfaceSymbols` に含まれれば `dispatch: "interface"`、そうでなければ `"static"`。追加 LSP コールなし。gopls が callee に concrete 実装を返すケースでは `"static"` にフォールバックする安全側設計（GO_SPEC.md §10.2 に既知の制限として明記）。tester 実機検証（gopls v0.21.1）で interface 経由呼び出しが正しく `"interface"` を返すことを確認。

#### #6 E2E テスト多言語化

`skills/e2e.test.ts` に TypeScript/Python/Rust/C# の言語別 `describe` ブロックを追加（+289行）。各言語の testdata で indexFacts → query → updateFacts → runAction のフルパイプラインを検証。LSP・ビルドツール依存部分は `test.skipIf` でガード。この E2E が後述の既存バグ2件を発見した。

#### #8 Java pmd / C++ clang-tidy 統合

`adapters/java/language-adapter.ts` に `parsePmdJson`（PMD JSON 出力をパース、フィールドは `description`/`beginLine`/`beginColumn` の camelCase、priority→severity マッピング）、`adapters/cpp/language-adapter.ts` に `parseClangTidyOutput`（`clang-analyzer-*,bugprone-*` チェック、stdout テキストパース）を追加。いずれも PATH 未存在で graceful degrade。

#### #9 Clojure/Elixir type_relations

clojure-lsp/elixir-ls は protocol/behaviour を返さないためパーサベースで抽出。Clojure `parseProtocolRelations`（`defprotocol`→interface、`defrecord`/`deftype`→class、inline 実装→`implements`）、Elixir `parseBehaviourRelations`（`@behaviour`、`defimpl ..., for: ...`→`implements`、module 単位）。`indexUnits` で LSP 由来分とマージ。

#### #10 InsightAdapter 型削除

`core/adapter/types.ts` の orphan な `InsightAdapter` / `InsightScope` インターフェースと不要な型 import を削除、`core/adapter/index.ts` とルート `index.ts` の export も削除。AI Insights 機能は `skills/insights.ts` で完結しており影響なし。SPEC.md §8.3 / CLAUDE.md「設計判断」を「型定義も削除済み」に更新。

#### #11 CI カバレッジ計測

`.github/workflows/test.yml` の `bun test` に `--coverage --coverage-reporter=lcov` + coverage アーティファクトアップロードを追加。`bunfig.toml` に coverage 設定、`package.json` に `test:coverage` スクリプト。`coverageThreshold` は意図的に未設定。

### ref, レビューで修正した点

- `parsePmdJson` の PMD JSON フィールド名誤り（`message`→`description` 等）を修正（correctness Critical）
- Go interface dispatch テストを `if` ガードの空テストから実効性のあるアサーションに修正、gopls 実機依存のため `["interface","static"]` 許容 + tester 委譲（quality High）
- README/SKILL の Java/C++ diagnostics 欄に pmd/clang-tidy 追記（consistency High）
- Clojure/Elixir の未使用・重複定数を整理

### refactor-advisor 適用（任意提案、全3件適用）

- Clojure/Elixir で `positionOf` を `offsetToPosition(source, offset)` としてファイルスコープに引き上げ、既存インライン計算と一本化
- Go テストアサーションに gopls 実機依存の理由コメント追加
- （PMD テストコメントは既存ありで不要）

### tester が発見した既存バグの修正（ユーザー承認のうえスコープ拡大）

- `core/index/index.ts`: `symbolByName`/`unitByFile`/`refsBySymbol` を `Object.create(null)` 化。TS testdata の `constructor()` メソッドが `Object.prototype.constructor` と衝突する prototype 汚染を解消
- `skills/update.ts`: unit ID prefix（`py`/`rs`/`cs` 等）と adapter.lang（`python`/`rust`/`csharp`）の不一致を `UNIT_PREFIX_TO_LANG` マッピングで解決
- `adapters/python/language-adapter.test.ts`: pyrightCmd 判別を `isPyrightAvailable()` と整合（今回の実装バグ）

---

> このドキュメントは内容を確認後に削除してください。
> `rm docs/plans/2026-05-19-remaining-7-tasks.md`

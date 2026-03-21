# ai-static-analysis

大規模コードベースに対する静的解析基盤。確定事実（facts）の生成・維持・クエリをスキルとして提供する。

## 配置

本レポジトリは各プロジェクトの `.claude/skills/static-analysis/` にクローンして使う。
エクスポートされるスキル定義（`*.md`）はレポジトリルートに配置し、Claude が直接参照できるようにする。

## プロジェクト構造

- `SPEC.md` — 仕様書（設計の正）
- `*.md`（ルート直下） — エクスポートされるスキル定義（Claude への指示書）
- `.claude/skills/` — 開発用メタスキル（このレポジトリ自体の開発支援）
- `core/` — 共通コア（スキーマ、fingerprint、dispatcher、ストレージ I/O）
- `adapters/` — 言語別アダプタ
- `skills/` — AI 操作単位の実装
- `cache/` — 生成物（Git 管理外）

## 基本原則

- 実解析は決定論ツール（LSP/コンパイラ/静的解析器）を使い、AI の推測で代替しない
- cache/ は安全に全削除できる設計にする
- 新しいスキルを作成する際は `.claude/skills/create-skill.md` のプロセスに従う
- 実装中の気づき・判断の根拠は CLAUDE.md の開発メモに残す
- 言語アダプタの実装・変更時は対応する `<LANG>_SPEC.md` を更新する

## スキル一覧

### メタスキル（開発支援、`.claude/skills/` 配下）

| スキル | 説明 |
|---|---|
| `create-skill` | 新しいスキルを作成するためのメタスキル |
| `improve-skill` | 既存のスキル定義を改善・更新するメタスキル |
| `update-lang-spec` | 言語アダプタの実装・変更時に `<LANG>_SPEC.md` を更新するメタスキル |

### 静的解析スキル（ルート直下、エクスポート対象）

| スキル | 説明 |
|---|---|
| `index-facts` | コードベース全体の静的解析を実行し、facts を生成 |
| `update-facts` | 変更ファイルのみを再解析し、facts を差分更新 |
| `query-facts` | facts に対してクエリを実行（deps/rdeps/defs/refs/diagnostics/impact） |
| `run-actions` | コードのフォーマット・チェック・テストを実行 |
| `analyze-insights` | facts とソースを読んで AI 分析を実行し、insights を生成 |
| `query-insights` | cache/insights.json から AI 分析結果をクエリ |
| `bootstrap-tools` | 不足する解析ツールを自動インストール |

## 実装状態

- ランタイム: Bun (TypeScript)
- MVP Step 1-3 完了（cache 管理、fingerprint、共通スキーマ、JSON I/O、アダプタフレームワーク）
- MVP Step 4 完了（Go アダプタ、言語別仕様体制）
- MVP Step 5-6 完了（skills 層: index/update/query/actions + core/diff）
- Step 7 完了（大規模対応: JSONL ストレージ、派生索引、クエリ最適化）
- Step 8 完了（AI Insights: loadInsightContext、query*、analyze-insights.md、query-insights.md）

## 開発メモ

- メタスキル (`create-skill`, `improve-skill`) は core/ の実装作業では出番がなかった。ルート直下のスキル定義 .md を作成する Step 5 以降で初めて使う想定。実際に使ってみてテンプレート・チェックリストが重すぎないか要検証
- Step 5-6: `applyDelta` は structuredClone で元データを保護。cascade 削除は unit→files→symbols→refs/type_relations/call_edges/diagnostics の順。`impactUnits` は file:prefix の有無を両方許容。
- Step 5-6: skills 層は `createRegistry()` で毎回新しいレジストリを生成する設計。将来 DI に変えるなら引数に渡す形に変更する。
- Step 5-6→修正済: Go adapter の cwd 問題を解決。ActionAdapter インターフェースに `repoRoot` を第一引数として追加。unit scope の unitId から `unit:go:` プレフィックスを除去してパスを抽出するよう修正。
- Go adapter: `exec()` に `env` パラメータを追加し、`goList()` で GOOS/GOARCH/GOTAGS 環境変数を Bun.spawn に渡すよう修正。
- gopls 連携: `gopls symbols`/`call_hierarchy`/`implementation` CLI を使って symbols/refs/call_edges/type_relations を取得。gopls 未インストール時は空配列にdegrade。現在はコマンドごとにプロセス spawn するため大規模リポではパフォーマンス課題あり（将来 LSP サーバーモードに移行予定）。
- Step 7: JSONL は `cache/facts/` ディレクトリの有無で自動判別（ディレクトリ優先）。`readFacts` は後方互換のため JSON フォールバックを維持。インデックスは `cache/index/` に JSON で保存。
- Step 7: `queryDefs`（name 検索）と `queryRefs` はインデックスがある場合のみ使用し、なければ既存のフルスキャンにフォールバック。
- Step 8: InsightAdapter インターフェース（外部 AI API 呼び出し）は実装しない設計。Claude Code 自身がスキル定義（.md）を読んで分析を行う。`skills/insights.ts` はコンテキスト準備と query* のみ担当。
- 参照解析完全化: gopls LSP `textDocument/references` を追加。型参照(type_ref)・フィールドアクセス(field_access)・一般参照(reference)を call 導出の refs に加えて収集。`findEnclosingSymbol` で参照元の関数/メソッドスコープを特定。
- サードパーティ linter 統合: `diagnose` に staticcheck(-f json)、errcheck(-abspath)、gosec(-fmt=json)、govulncheck(-json) を統合。全てオプションで未インストール時は graceful degrade。
- 循環依存検出: `detectCyclicDeps` で deps グラフを DFS し循環を検出。`diagnose` 内で常時実行（外部ツール不要）。
- セキュリティ: gosec（コードレベルのセキュリティ問題）と govulncheck（依存脆弱性）を diagnostics に統合。
- bootstrap(): LanguageAdapter インターフェースに追加。Go adapter は `go install` で gopls/staticcheck/errcheck/gosec/govulncheck/dupl を自動インストール。doctor() は不足ツールに対して bootstrap ヒントを表示。
- デッドコード検出: `queryDeadCode()` を query-facts に追加。exported symbol × refs/call_edges のゼロ参照チェック。main/init/TestXxx/interface実装を除外。
- コード重複検出: Go adapter の `diagnose` に `dupl -plumbing` を統合。重複ブロックを diagnostics として報告。bootstrap 対象にも追加。
- 共通化候補: Insights スキーマに `DuplicationHint` 型を追加（extract_function/extract_interface/extract_module/parameterize）。`analyze-insights` が dupl diagnostics を手がかりにソースを分析して共通化提案を生成。`queryDuplicationHints()` で取得。

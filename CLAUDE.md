# ai-static-analysis

大規模コードベースに対する静的解析基盤。確定事実（facts）の生成・維持・クエリをスキルとして提供する。

## 配置

本レポジトリは各プロジェクトの `.claude/skills/ai-static-analysis/` にクローンして使う。
Claude Code はこのディレクトリの `SKILL.md` をエントリポイントとして自動検出する。
導入手順の詳細は `setup.md` を参照。

## プロジェクト構造

- `SPEC.md` — 仕様書（設計の正）
- `*.md`（ルート直下） — エクスポートされるスキル定義（Claude への指示書）
- `setup.md` — 対象プロジェクトへの導入スキル
- `templates/` — 対象プロジェクト用テンプレート（CLAUDE.md スニペット等）
- `scripts/` — フック用スクリプト（SessionStart チェック等）
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
| `setup` | 対象プロジェクトへの導入（CLAUDE.md テンプレ + SessionStart フック設定） |
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
- 言語アダプタ拡充: TypeScript, Python, C#, Rust アダプタを追加。共通ユーティリティを `adapters/shared/` に切り出し。各アダプタは detect/enumerateUnits/indexUnits(files+deps)/diagnose/doctor/bootstrap + ActionAdapter を実装。シンボル/参照/型関係/呼び出しグラフは LSP 統合時に追加予定（現状は graceful degrade で空配列）。
- MVP Step 5-6 完了（skills 層: index/update/query/actions + core/diff）
- Step 7 完了（大規模対応: JSONL ストレージ、派生索引、クエリ最適化）
- Step 8 完了（AI Insights: loadInsightContext、query*、analyze-insights.md、query-insights.md）

## 開発メモ

### 設計判断

- InsightAdapter（外部 AI API 呼び出し）は実装しない設計。Claude Code 自身がスキル定義（.md）を読んで分析を行う。`skills/insights.ts` はコンテキスト準備と query* のみ担当。
- skills 層は `createRegistry()` で毎回新しいレジストリを生成する設計。将来 DI に変えるなら引数に渡す形に変更する。
- JSONL 一本化済み。legacy JSON（`facts.json` 単一ファイル）サポートは完全削除。`readFacts` は `readFactsPartial(cacheDir, ALL_FIELDS)` の薄いラッパー。

### Go アダプタ

- gopls 連携: `GoplsLspClient` で `gopls serve` を1プロセス起動し JSON-RPC (stdio) で documentSymbol/callHierarchy/references/implementation を通信。gopls 未インストール時は空配列に degrade。
- 参照解析: gopls `textDocument/references` で型参照(type_ref)・フィールドアクセス(field_access)・一般参照(reference)を収集。`findEnclosingSymbol` で参照元スコープを特定。
- linter 統合: staticcheck(-f json)、errcheck(-abspath)、gosec(-fmt=json)、govulncheck(-json)、dupl(-plumbing) を `diagnose` に統合。全てオプション。
- 循環依存検出: `detectCyclicDeps` で deps グラフを DFS し循環を検出（外部ツール不要）。

### ストレージ・クエリ最適化

- JSONL 分割読み: `readFactsPartial(cacheDir, fields)` で必要なフィールドだけ読み込み。キャッシュはフィールド単位で増分マージ。
- クエリキャッシュ: `skills/query.ts` に in-process facts キャッシュ（30秒 TTL）。`clearFactsCache()` でリセット可能。
- 書き込み中断耐性: `writeFactsJsonl` で `write_complete` マーカーを meta.json に導入。
- `queryDefs`/`queryRefs` はインデックスがある場合のみ使用し、なければフルスキャンにフォールバック。

### 差分更新・diff

- `applyDelta` は structuredClone で元データを保護。cascade 削除は unit→files→symbols→refs/type_relations/call_edges/diagnostics の順。
- `impactUnits` は file:prefix の有無を両方許容。
- `FactsDelta.removed.refs` と `removed.call_edges` は `site` フィールドで一意特定。

### その他

- デッドコード検出: receiver 型のマッチングは `(unit_id, name)` ペアの Map ベース検索（同名型の誤判定防止）。
- `diagnose()` に `deps?: Dep[]` オプション引数を追加し、`goList` 二重実行を回避。
- メタスキル (`create-skill`, `improve-skill`) は core/ 実装時は不使用。スキル定義 .md 作成時に使用。

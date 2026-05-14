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
- 機能追加・言語対応・スキル変更など実装状態が変わった場合は `README.md` の該当箇所（対応言語テーブル、スキル一覧、特徴等）も合わせて更新する

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
| `query-facts` | facts に対してクエリを実行（deps/rdeps/defs/refs/diagnostics/impact）。SARIF エクスポート対応 |
| `run-actions` | コードのフォーマット・チェック・テストを実行 |
| `analyze-insights` | facts とソースを読んで AI 分析を実行し、insights を生成 |
| `query-insights` | cache/insights.json から AI 分析結果をクエリ |
| `bootstrap-tools` | 不足する解析ツールを自動インストール |
| `compare-facts` | 2 スナップショット間で facts を diff（units/files/deps/symbols/diagnostics + 影響範囲） |
| `visualize-graph` | deps / call_edges を Mermaid または DOT でレンダリング |

## 実装状態

- ランタイム: Bun (TypeScript)
- MVP Step 1-3 完了（cache 管理、fingerprint、共通スキーマ、JSON I/O、アダプタフレームワーク）
- MVP Step 4 完了（Go アダプタ、言語別仕様体制）
- 言語アダプタ拡充: TypeScript, Python, C#, Rust アダプタを追加。共通ユーティリティを `adapters/shared/` に切り出し。各アダプタは detect/enumerateUnits/indexUnits(files+deps)/diagnose/doctor/bootstrap + ActionAdapter を実装。全言語で LSP 統合済み（TypeScript: typescript-language-server、Python: pyright、C#: csharp-ls、Rust: rust-analyzer）。LSP 未インストール時は graceful degrade で空配列。
- MVP Step 5-6 完了（skills 層: index/update/query/actions + core/diff）
- Step 7 完了（大規模対応: JSONL ストレージ、派生索引、クエリ最適化）
- Step 8 完了（AI Insights: loadInsightContext、query*、analyze-insights.md、query-insights.md）
- Java アダプタ追加: unit 列挙（Maven/Gradle）、deps（import → package_prefixes マッチ）、jdtls 経由で symbols / refs / call_edges / type_relations を抽出。jdtls 未導入時は parser ベースで top-level 型のみの degrade。Action は Gradle/Maven。`JAVA_SPEC.md` 参照。
- SARIF v2.1.0 エクスポート: `core/sarif/diagnosticsToSarif` で `Diagnostic[]` → SARIF Log を生成。tool ごとに run を分け、ruleId は `[code]` トークンから導出（無ければ tool 名）。GitHub code scanning と直接連携可能。
- compare-facts スキル: 2 つの cacheDir を比較し、units/files/deps/symbols/diagnostics の +/- と（オプションで）影響範囲を返す。`skills/compare.ts`。
- visualize-graph スキル: facts を Mermaid または DOT に変換。`kind: "deps"` で unit 依存、`kind: "callgraph"` で関数間呼び出し。`include`/`match`/`maxEdges` でフィルタリング・トランケーション。`skills/visualize.ts`。

## 開発メモ

### 設計判断

- InsightAdapter（外部 AI API 呼び出し）は実装しない設計。Claude Code 自身がスキル定義（.md）を読んで分析を行う。`skills/insights.ts` はコンテキスト準備と query* のみ担当。
- skills 層は `createRegistry()` で毎回新しいレジストリを生成する設計。将来 DI に変えるなら引数に渡す形に変更する。
- JSONL 一本化済み。legacy JSON（`facts.json` 単一ファイル）サポートは完全削除。`readFacts` は `readFactsPartial(cacheDir, ALL_FIELDS)` の薄いラッパー。

### LSP 座標規約

- facts 出力の全 position フィールド（`decl.position`、`site.position` 等）は **1-based** (line, column ともに 1 始まり) で統一する。LSP プロトコルは 0-based を返すため、各言語アダプタで `+1` 変換が必要。
- 座標変換は `decl.position` と `site.position`（refs/call_edges）の **両方** に適用すること。片方だけ修正すると横断クエリで不整合が起きる。
- 共通ユーティリティ（`adapters/shared/lsp-client.ts` の `SYMBOL_KIND_MAP` 等）は LSP 仕様 (SymbolKind enum) と照合して検証すること。

### Go アダプタ

- gopls 連携: `GoplsLspClient` で `gopls serve` を1プロセス起動し JSON-RPC (stdio) で documentSymbol/callHierarchy/references/implementation を通信。gopls 未インストール時は空配列に degrade。
- 参照解析: gopls `textDocument/references` で型参照(type_ref)・フィールドアクセス(field_access)・一般参照(reference)を収集。`findEnclosingSymbol` で参照元スコープを特定。
- linter 統合: staticcheck(-f json)、errcheck(-abspath)、gosec(-fmt=json)、govulncheck(-json)、dupl(-plumbing) を `diagnose` に統合。全てオプション。
- gopls 内蔵アナライザ統合: `LspClient.pullDiagnostics` で `textDocument/diagnostic` (LSP 3.17 pull-mode) を発行し、modernize/inline/rangeint/stringsbuilder 等の hint を `diagnose` に取り込む。tool 名は `gopls/<analyzer>` 形式（`source` 由来）。CLI 系統合では拾えない hint を補うのが目的。`externalClient` がある場合は再利用、無ければ独立した `GoplsLspClient` を起動して fin で shutdown。pull モードはファイル毎に `didOpen` → pull → `didClose` する必要あり（gopls は didOpen 済みファイルにしか診断を返さない）。
- 循環依存検出: `detectCyclicDeps` で deps グラフを DFS し循環を検出（外部ツール不要）。

### ストレージ・クエリ最適化

- JSONL 分割読み: `readFactsPartial(cacheDir, fields)` で必要なフィールドだけ読み込み。キャッシュはフィールド単位で増分マージ。
- クエリキャッシュ: `skills/query.ts` に in-process facts キャッシュ（30秒 TTL）。`clearFactsCache()` でリセット可能。`skills/index.ts` と `skills/update.ts` は `writeFactsJsonl` 直後に自動で `clearFactsCache()` を呼ぶ。
- 書き込み中断耐性: `writeFactsJsonl` で `write_complete` マーカーを meta.json に導入。
- `queryDefs`/`queryRefs` はインデックスがある場合のみ使用し、なければフルスキャンにフォールバック。
- `queryImpact` は deps の逆引き（rdeps）+ type_relations + call_edges を辿って推移的に影響 unit を展開する（SPEC.md §9.2 準拠）。

### 差分更新・diff

- `applyDelta` は structuredClone で元データを保護。cascade 削除は unit→files→symbols→refs/type_relations/call_edges/diagnostics の順。
- `impactUnits` は file:prefix の有無を両方許容。
- `FactsDelta.removed.refs` と `removed.call_edges` は `site` フィールドで一意特定。

### その他

- デッドコード検出: receiver 型のマッチングは `(unit_id, name)` ペアの Map ベース検索（同名型の誤判定防止）。
- `diagnose()` に `deps?: Dep[]` オプション引数を追加し、`goList` 二重実行を回避。
- メタスキル (`create-skill`, `improve-skill`) は core/ 実装時は不使用。スキル定義 .md 作成時に使用。
- TypeScript linter フック（tsc）は未使用 import・未使用変数・未使用関数を検出してコミットをブロックする。実装時は import 追加・削除のたびに使用箇所の有無を確認すること。
- `storage.ts` と `query.ts` の間には循環依存がある。`writeFactsJsonl` 後に `clearFactsCache` を呼ぶ場合は動的 import（`await import('./query.ts')`）で回避すること。

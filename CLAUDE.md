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

## 実装状態

- ランタイム: Bun (TypeScript)
- MVP Step 1-3 完了（cache 管理、fingerprint、共通スキーマ、JSON I/O、アダプタフレームワーク）
- MVP Step 4 完了（Go アダプタ、言語別仕様体制）
- MVP Step 5-6 完了（skills 層: index/update/query/actions + core/diff）

## 開発メモ

- メタスキル (`create-skill`, `improve-skill`) は core/ の実装作業では出番がなかった。ルート直下のスキル定義 .md を作成する Step 5 以降で初めて使う想定。実際に使ってみてテンプレート・チェックリストが重すぎないか要検証
- Step 5-6: `applyDelta` は structuredClone で元データを保護。cascade 削除は unit→files→symbols→refs/type_relations/call_edges/diagnostics の順。`impactUnits` は file:prefix の有無を両方許容。
- Step 5-6: skills 層は `createRegistry()` で毎回新しいレジストリを生成する設計。将来 DI に変えるなら引数に渡す形に変更する。
- Step 5-6: Go adapter の `go fmt ./...` は cwd が設定されない問題あり（adapter 側の課題）。skills/actions のテストでは files scope で回避。

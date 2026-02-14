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

## スキル一覧

### メタスキル（開発支援、`.claude/skills/` 配下）

| スキル | 説明 |
|---|---|
| `create-skill` | 新しいスキルを作成するためのメタスキル |
| `improve-skill` | 既存のスキル定義を改善・更新するメタスキル |

### 静的解析スキル（ルート直下、エクスポート対象）

| スキル | 説明 |
|---|---|
| `index-facts` | コードベース全体の静的解析を実行し、facts を生成 |
| `update-facts` | 変更ファイルのみを再解析し、facts を差分更新 |
| `query-facts` | facts に対してクエリを実行（deps/rdeps/defs/refs/diagnostics/impact） |
| `run-actions` | コードのフォーマット・チェック・テストを実行 |

## 実装状態

- ランタイム: Bun (TypeScript)
- 現在 MVP Step 1-2 実装中（cache 管理、fingerprint、共通スキーマ、JSON I/O）
- adapters/ および skills/ の実装コードは未着手

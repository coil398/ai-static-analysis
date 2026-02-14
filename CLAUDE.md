# ai-static-analysis

大規模コードベースに対する静的解析基盤。確定事実（facts）の生成・維持・クエリをスキルとして提供する。

## プロジェクト構造

- `SPEC.md` — 仕様書（設計の正）
- `.claude/skills/` — スキル定義（Claude への指示書）
- `core/` — 共通コア（スキーマ、fingerprint、dispatcher、ストレージ I/O）
- `adapters/` — 言語別アダプタ
- `skills/` — AI 操作単位の実装
- `cache/` — 生成物（Git 管理外）

## 基本原則

- 実解析は決定論ツール（LSP/コンパイラ/静的解析器）を使い、AI の推測で代替しない
- cache/ は安全に全削除できる設計にする
- 新しいスキルを作成する際は `.claude/skills/create-skill.md` のプロセスに従う

## スキル一覧

| スキル | 説明 |
|---|---|
| `create-skill` | 新しいスキルを作成するためのメタスキル |

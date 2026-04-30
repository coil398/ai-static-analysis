# ai-static-analysis

大規模コードベースに対する静的解析基盤スキル（Claude Code 用）。

LSP・コンパイラ・静的解析器などの決定論ツールを使い、コードベースの「確定事実（facts）」を生成・維持・クエリする。AI の推測ではなく、再現可能な解析結果に基づいて依存関係・参照・影響範囲・診断情報を提供する。

## 特徴

- **Facts ベースの解析** — LSP/コンパイラ/linter の出力を構造化データ（facts）として保存・クエリ
- **差分更新** — 変更ファイルだけを再解析するインクリメンタル更新で大規模コードベースに対応
- **多言語対応** — Go, TypeScript, Python, C#, Rust をサポート
- **Fingerprint による整合性管理** — ツールバージョン・ビルド条件・コード状態を記録し、不整合を検知
- **AI 分析（Insights）** — facts を元にバグ臭・設計パターン・命名・重複等の AI 分析を実行

## 対応言語

| 言語 | unit 列挙 | 依存解析 | シンボル定義 | 参照・呼出 | 型関係 | diagnostics | format/check/test |
|---|---|---|---|---|---|---|---|
| **Go** | :white_check_mark: | :white_check_mark: | :white_check_mark: (gopls) | :white_check_mark: (gopls) | :white_check_mark: (gopls) | :white_check_mark: (gopls 内蔵アナライザ + staticcheck等) | :white_check_mark: |
| **TypeScript** | :white_check_mark: | :white_check_mark: | :white_check_mark: (typescript-language-server) | :white_check_mark: (typescript-language-server) | :white_check_mark: (typescript-language-server) | :white_check_mark: (tsc) | :white_check_mark: |
| **Python** | :white_check_mark: | :white_check_mark: | :white_check_mark: (pyright) | :white_check_mark: (pyright) | :white_check_mark:* | :white_check_mark: | :white_check_mark: |
| **C#** | :white_check_mark: | :white_check_mark: | :white_check_mark: (csharp-ls) | :white_check_mark: (csharp-ls) | :white_check_mark: (csharp-ls) | :white_check_mark: | :white_check_mark: |
| **Rust** | :white_check_mark: | :white_check_mark: | :white_check_mark: (rust-analyzer) | :white_check_mark: (rust-analyzer) | :white_check_mark: (rust-analyzer) | :white_check_mark: | :white_check_mark: |

> \* Python の型関係は pyright が `textDocument/implementation` を未サポートのため、Python 標準ライブラリの `ast` モジュールによるクラス継承の検出で対応（`adapters/python/extract_bases.py`）。

> 各言語とも LSP サーバーが未インストールの場合は空配列に graceful degrade します。

## セットアップ

### 前提条件

- [Bun](https://bun.sh/) がインストール済みであること
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) が利用可能であること

### 導入手順

```bash
# 1. 対象プロジェクトにクローン
cd <対象プロジェクト>
mkdir -p .claude/skills
git clone <ai-static-analysis-repo-url> .claude/skills/ai-static-analysis

# 2. 依存パッケージをインストール
cd .claude/skills/ai-static-analysis
bun install

# 3. Claude Code で setup スキルを実行
# → CLAUDE.md への追記、SessionStart フック設定、.gitignore 設定を行う
```

詳細は [setup.md](setup.md) を参照。

## 使い方

### スキル一覧

| スキル | 説明 |
|---|---|
| `setup` | 対象プロジェクトへの導入（CLAUDE.md + フック設定） |
| `bootstrap-tools` | 不足する解析ツール（gopls, staticcheck 等）を自動インストール |
| `index-facts` | コードベース全体を静的解析し facts を生成（フルビルド） |
| `update-facts` | 変更ファイルのみを再解析し facts を差分更新 |
| `query-facts` | 依存関係・定義・参照・診断・影響範囲・デッドコード等をクエリ |
| `run-actions` | format / check / test を言語別に実行 |
| `analyze-insights` | facts とソースを読んで AI 分析を実行 |
| `query-insights` | 生成済み insights をクエリ |

### 基本的な流れ

```
# 1. 初回: 解析ツールの導入 → facts 生成
bootstrap-tools → index-facts

# 2. 日常: 差分更新 → クエリ
update-facts → query-facts

# 3. コード検証
run-actions (format / check / test)

# 4. AI 分析
analyze-insights → query-insights
```

### クエリ例

```
# 依存関係を調べる
query-facts で internal/service の依存先を調べてください

# 影響範囲を確認
query-facts で main.go の変更の影響範囲を調べてください

# デッドコード検出
query-facts でデッドコードを検出してください

# 診断情報を取得
query-facts で diagnostics を取得してください
```

## プロジェクト構造

```
ai-static-analysis/
├── core/           # 共通コア（スキーマ、fingerprint、dispatcher、ストレージ I/O、差分更新）
├── adapters/       # 言語別アダプタ（Go, TypeScript, Python, C#, Rust）
│   └── shared/     # 共通ユーティリティ
├── skills/         # AI 操作単位の実装（index/update/query/actions/insights）
├── scripts/        # フック用スクリプト（SessionStart チェック等）
├── templates/      # 対象プロジェクト用テンプレート
├── cache/          # 生成物（Git 管理外、安全に全削除可能）
├── SPEC.md         # 仕様書
├── SKILL.md        # スキルエントリポイント（Claude Code が自動検出）
└── *.md            # 各スキル定義
```

## 設計原則

- 実解析は決定論ツール（LSP/コンパイラ/静的解析器）を使い、AI の推測で代替しない
- `cache/` は安全に全削除できる設計
- Fingerprint でツールバージョン・ビルド条件の変更を検知し、整合性を保つ
- JSONL 分割形式で大規模コードベースに対応（必要なフィールドだけ読み込み）

## ライセンス

Private

---
name: ai-static-analysis
description: >
  大規模コードベースに対する静的解析基盤。LSP/コンパイラ/静的解析器を使い、確定事実（facts）の生成・維持・クエリを提供する。
  コードの依存関係・定義・参照・診断・影響範囲・デッドコード・コール グラフの調査、コードのフォーマット・チェック・テスト実行、
  AI によるバグ臭・設計パターン・命名品質・重複候補の分析に使う。
  「静的解析して」「依存関係を調べて」「影響範囲は？」「デッドコードある？」「コード品質を分析して」「facts を更新して」
  「診断結果を見せて」「この変更の影響は？」といった要望に対応する。
---

# ai-static-analysis

大規模コードベースに対する静的解析基盤。決定論ツール（LSP/コンパイラ/静的解析器）を使い、確定事実（facts）の生成・維持・クエリを提供する。

---

## セットアップ

### 1. クローン

```bash
cd <対象プロジェクト>
mkdir -p .claude/skills
git clone <ai-static-analysis-repo-url> .claude/skills/ai-static-analysis
```

### 2. 導入

`setup.md` の手順に従い、以下を設定する:

- 対象プロジェクトの `CLAUDE.md` にワークフロー案内を追記
- `settings.json` に SessionStart フックを設定（セッション開始時に facts の鮮度を自動チェック）
- `.gitignore` に `cache/` を追加

### 3. セッション起動時の動作

設定後、Claude Code を起動すると SessionStart フックが自動実行され、facts の状態に応じてガイドが表示される:

```
[static-analysis] facts が未生成です。index-facts を実行してコードベースを解析してください。
[static-analysis] facts 生成後に 12 ファイルが変更されています。update-facts で差分更新できます。
[static-analysis] facts は最新です。query-facts でクエリ可能です。
```

---

## 対応言語

Go, TypeScript, Python, C#, Rust

## 前提

- ランタイム: Bun
- 各言語の解析ツールはローカルにインストールされている前提（不足時は `bootstrap-tools` で自動導入可能）
- 生成物は `cache/` に保存され、安全に全削除できる

---

## コマンド一覧

### 初回セットアップ

| コマンド | 説明 |
|---|---|
| `setup` | 対象プロジェクトへの導入（CLAUDE.md + フック設定） |
| `bootstrap-tools` | 不足する解析ツール（gopls, staticcheck 等）を自動インストール |

### 解析（facts の生成・更新）

| コマンド | 説明 |
|---|---|
| `index-facts` | コードベース全体を静的解析し facts を生成（フルビルド） |
| `update-facts` | 変更ファイルのみを再解析し facts を差分更新（高速） |

### クエリ（facts の検索）

| コマンド | 説明 |
|---|---|
| `query-facts` | 依存関係・定義・参照・診断・影響範囲・デッドコード等をクエリ |

### アクション（コード検証）

| コマンド | 説明 |
|---|---|
| `run-actions` | format / check / test を言語別に実行 |

### AI 分析（insights）

| コマンド | 説明 |
|---|---|
| `analyze-insights` | facts とソースを読んで AI 分析（バグ臭・設計パターン・命名・重複等）を実行 |
| `query-insights` | 生成済み insights をクエリ |

---

## 基本的な使い方

### 1. facts を生成する

```
index-facts を実行してください（repoRoot: /path/to/repo）
```

初回は `bootstrap-tools` → `index-facts` の順。2回目以降、変更が少なければ `update-facts` で差分更新。

### 2. facts をクエリする

```
query-facts で CreateUser の定義を検索してください
query-facts で main.go の診断を取得してください
query-facts で internal/service の依存先を調べてください
```

### 3. コード検証する

```
run-actions で check を実行してください
run-actions で変更ファイルの format を実行してください
```

### 4. AI 分析する

```
analyze-insights を実行してください
query-insights でバグ臭を取得してください
```

---

## 各コマンドの詳細

各コマンドの API・処理フロー・使用例は個別のスキル定義を参照：

- [`setup.md`](setup.md)
- [`index-facts.md`](index-facts.md)
- [`update-facts.md`](update-facts.md)
- [`query-facts.md`](query-facts.md)
- [`run-actions.md`](run-actions.md)
- [`analyze-insights.md`](analyze-insights.md)
- [`query-insights.md`](query-insights.md)
- [`bootstrap-tools.md`](bootstrap-tools.md)

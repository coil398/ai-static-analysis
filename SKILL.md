---
name: ai-static-analysis
description: >
  大規模コードベースの静的解析基盤。LSP/コンパイラ/静的解析器で確定事実（facts）を生成・維持・クエリする。
  依存関係・参照・影響範囲・デッドコード・コールグラフの調査、format/check/test 実行、AI によるバグ臭・設計パターン分析に対応。
  「静的解析して」「依存関係を調べて」「影響範囲は？」「デッドコードある？」「facts を更新して」「この変更の影響は？」等の要望に使う。
  また、以下のような間接的な要望でも積極的にこのスキルを使うこと：
  「このファイル変えたけど大丈夫？」「どこに影響する？」「使ってない関数ある？」「lint 通る？」「テスト回して」
  「このモジュールの依存先は？」「誰がこの関数呼んでる？」「コード品質どう？」「フォーマットして」
  「リファクタリング前に確認したい」「変更の安全性を担保して」「コードベース全体を把握したい」等。
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

## ワークフロー判断ガイド

Claude がこのスキルを使う際の判断フローを以下に示す。

### SessionStart フックの出力に応じた判断

| フックメッセージ | 次のアクション |
|---|---|
| `facts が未生成です` | `bootstrap-tools` → `index-facts` の順に実行 |
| `fingerprint が見つかりません` | `index-facts` でフルリビルド |
| `N 日前のもの` / `N ファイルが変更` | `update-facts` で差分更新（大量変更時は `index-facts`） |
| `facts は最新です` | そのまま `query-facts` を使用可能 |

### ユーザー要望に応じた判断

```
ユーザーの要望を受け取る
│
├─ 「影響範囲は？」「どこに影響する？」
│   → facts が最新か確認 → 古ければ update-facts → query-facts impact
│
├─ 「依存関係を調べて」「誰がこの関数呼んでる？」
│   → query-facts (deps/rdeps/callers/callees)
│
├─ 「デッドコードある？」「使ってない関数？」
│   → query-facts deadCode
│   ※ LSP サーバー未インストールの場合はシンボルレベルの検出不可（deps/diagnostics は利用可能）
│
├─ 「lint 通る？」「フォーマットして」「テスト回して」
│   → run-actions (check/format/test)
│
├─ 「コード品質どう？」「バグ臭ない？」「設計パターンは？」
│   → analyze-insights → query-insights
│
├─ 「静的解析して」「コードベース全体を把握したい」
│   → index-facts（未生成時）or update-facts → query-facts + analyze-insights
│
└─ 「リファクタリング前に確認したい」「変更の安全性を担保して」
    → update-facts → query-facts impact → run-actions check → run-actions test
```

### facts 鮮度の自動判断

facts を使うクエリの前に、以下を確認する:
1. `cache/facts/` が存在するか → なければ `index-facts` を提案
2. `cache/fingerprint.json` の `repo_state.commit` と現在の HEAD が一致するか → 不一致なら `update-facts` を提案
3. 一致していればそのまま `query-facts` を実行

---

## 対応言語

| 言語 | unit 列挙 | 依存解析 | シンボル定義 | 参照・呼出 | 型関係 | diagnostics | format/check/test |
|---|---|---|---|---|---|---|---|
| **Go** | ✅ | ✅ | ✅ (gopls) | ✅ (gopls) | ✅ (gopls) | ✅ (staticcheck等) | ✅ |
| **TypeScript** | ✅ | ✅ | ✅ (typescript-language-server) | ✅ (typescript-language-server) | ✅ (typescript-language-server) | ✅ (tsc) | ✅ |
| **Python** | ✅ | ✅ | ✅ (pyright) | ✅ (pyright) | ✅* | ✅ | ✅ |
| **C#** | ✅ | ✅ | ✅ (csharp-ls) | ✅ (csharp-ls) | ✅ (csharp-ls) | ✅ | ✅ |
| **Rust** | ✅ | ✅ | ✅ (rust-analyzer) | ✅ (rust-analyzer) | ✅ (rust-analyzer) | ✅ | ✅ |

> \* Python の型関係は pyright が `textDocument/implementation` を未サポートのため、ソースコードのパターンマッチによる直接継承の検出のみ対応。
> 各言語とも LSP サーバーが未インストールの場合は空配列に graceful degrade する。

## 前提

- ランタイム: Bun
- 各言語の解析ツールはローカルにインストールされている前提（不足時は `bootstrap-tools` で自動導入可能）
- 生成物は `<repoRoot>/cache/` に保存され（`cacheDir` オプションで変更可能）、安全に全削除できる

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

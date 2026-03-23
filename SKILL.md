# static-analysis

大規模コードベースに対する静的解析基盤。決定論ツール（LSP/コンパイラ/静的解析器）を使い、確定事実（facts）の生成・維持・クエリを提供する。

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

- [`index-facts.md`](index-facts.md)
- [`update-facts.md`](update-facts.md)
- [`query-facts.md`](query-facts.md)
- [`run-actions.md`](run-actions.md)
- [`analyze-insights.md`](analyze-insights.md)
- [`query-insights.md`](query-insights.md)
- [`bootstrap-tools.md`](bootstrap-tools.md)

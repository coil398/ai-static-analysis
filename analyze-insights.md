# analyze-insights スキル

コードベースの AI 分析を実行し、結果を `cache/insights.json` に保存する。

## 概要

このスキルを実行する Claude 自身が分析主体となる。TypeScript ランタイム（`skills/insights.ts`）は「分析対象コンテキストの準備」専任であり、外部 AI API は呼び出さない。

## 実行手順

### 1. コンテキスト取得

```typescript
import { loadInsightContext } from "./skills/insights.ts";

const ctx = await loadInsightContext({
  repoRoot: "<REPO_ROOT>",          // 対象リポジトリのパス
  cacheDir: "<CACHE_DIR>",          // 省略時は <repoRoot>/cache
  scope: {                          // 省略時は全ファイル
    unit_ids: ["unit:go:."],        // 対象 unit に絞る場合
    // symbol_ids: [...],
    // file_ids: [...],
  },
});
// ctx.facts   — Facts オブジェクト（units, symbols, files, deps, …）
// ctx.sources — { [file_id]: ソースコード本文 }
```

### 2. 分析実施

`ctx.facts` と `ctx.sources` を読んで、以下の 5 種類の分析を行う。

#### intent_tags — 役割ラベリング

units と symbols を読み、それぞれの「役割」を 1 ラベルで表現する。

```
例: "entry-point", "repository-pattern", "auth-guard", "error-handler"
```

#### summaries — 自然言語要約

units、files、symbols について 1-3 文の要約を生成する。

#### bug_smells — バグ臭検出

`ctx.sources` のソースコードを読んで、次のカテゴリを検出する：

- `swallowed_error` — エラーを無視している箇所
- `nil_check_missing` — nil/null チェックなしのポインタ操作
- `race_condition` — 共有状態への非同期アクセス
- `resource_leak` — クローズされないファイル/接続
- `unchecked_cast` — 型アサーションの未チェック
- `logic_error` — 条件分岐や計算の明らかな誤り
- `other` — 上記に当てはまらない疑わしいパターン

#### pattern_tags — 設計パターン識別

units と symbols から設計パターンを検出する。

```
例: "factory", "observer", "repository", "singleton", "adapter", "command"
```

#### duplication_hints — 重複・共通化候補

`ctx.sources` とシンボル構造を分析し、以下を検出する：

- 類似した処理ロジックを持つ関数群 → `extract_function`
- 共通インターフェースに抽象化できる型群 → `extract_interface`
- モジュール分割で共通化できるコード → `extract_module`
- パラメータ化で統一できる微差のコード → `parameterize`

`ctx.facts.diagnostics` に `tool: "dupl"` のエントリがある場合、それを手がかりにソースを確認し、具体的な共通化提案を生成する。

```
例: { target_ids: ["sym:go:pkg#func#CreateUser", "sym:go:pkg#func#UpdateUser"],
       suggestion: "extract_function", message: "Both functions share identical validation logic (lines 10-25). Extract to a validateUser() helper." }
```

#### naming_issues — 命名品質レビュー

symbols の名前を評価し、次のカテゴリを記録する：

- `misleading` — 実際の動作と名前が乖離
- `too_abbreviated` — 略語が分かりにくい
- `inconsistent` — 同一コードベースの命名規則と不一致
- `too_generic` — 意味のない汎用名
- `other`

### 3. JSON 整形と保存

分析結果を以下の `Insights` 型に整形する：

```typescript
interface Insights {
  schema_version: 1;
  snapshot: { commit: string; created_at: string };  // ctx.facts.snapshot と同じ
  intent_tags:       IntentTag[];
  summaries:         Summary[];
  bug_smells:        BugSmell[];
  pattern_tags:      PatternTag[];
  naming_issues:     NamingIssue[];
  duplication_hints: DuplicationHint[];
}

interface InsightMeta {
  model: string;        // 使用したモデル ID（例: "claude-sonnet-4-6"）
  confidence: number;   // 0..1（確信度）
  generated_at: string; // ISO 8601
}
```

各 insight に `meta: InsightMeta` を付与すること。

```typescript
import { writeInsights } from "./core/storage/index.ts";

await writeInsights("<CACHE_DIR>", insights);
```

### スコープと自動分割

スコープ未指定（全体分析）の場合、コンテキストサイズが大きくなりすぎる。以下の手順で自動分割する:

1. `ctx.facts.units` を取得し、自動生成コードの unit（unit 内の全ファイルが `generated: true`）を除外
2. 残った units を 1 unit ずつ処理する
3. 各 unit について:
   a. `loadInsightContext` に `scope: { unit_ids: [unitId] }` を渡してコンテキストを取得
   b. そのコンテキストに対して分析を実施
   c. 結果を蓄積
4. 全 unit の結果を結合して `cache/insights.json` に保存する

```typescript
import { loadInsightContext } from "./skills/insights.ts";
import { readFacts, writeInsights } from "./core/storage/index.ts";

// 全 unit を取得し、全ファイルが generated の unit を除外
const allFacts = await readFacts(cacheDir);
const targetUnits = allFacts.units.filter((unit) => {
  const unitFiles = allFacts.files.filter((f) => f.unit_id === unit.id);
  // ファイルが存在し、かつ全てが generated な unit はスキップ
  return unitFiles.length === 0 || !unitFiles.every((f) => f.generated);
});

// unit ごとに分析を実施して結果を蓄積
const allInsights = { intent_tags: [], summaries: [], bug_smells: [], pattern_tags: [], naming_issues: [], duplication_hints: [] };
for (const unit of targetUnits) {
  const ctx = await loadInsightContext({
    repoRoot: "<REPO_ROOT>",
    cacheDir: "<CACHE_DIR>",
    scope: { unit_ids: [unit.id] },
  });
  // 各 unit に対して分析を実施し、結果を allInsights に追記
  // ...
}

// 結合した結果を保存
await writeInsights("<CACHE_DIR>", { schema_version: 1, snapshot: allFacts.snapshot, ...allInsights });
```

## 注意事項

- **決定論的 facts と混在させない**：`cache/insights.json` は `cache/facts/`（JSONL）とは別ファイル。
- **信頼度の正直な表現**：確信が持てない場合は `confidence` を低め（0.3〜0.5）に設定する。
- **スコープ外の分析は行わない**：`ctx.sources` に含まれないファイルの内容を推測しない。
- **バグ臭の誤検知に注意**：`high` severity は「かなり確実」な場合のみ使用する。

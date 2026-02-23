# query-insights スキル

`cache/insights.json` に保存された AI 分析結果をクエリする。

## 前提

`analyze-insights` スキルを先に実行して `cache/insights.json` を生成しておくこと。

## クエリ関数一覧

```typescript
import {
  queryIntents,
  querySummaries,
  querySmells,
  queryPatterns,
  queryNaming,
} from "./skills/insights.ts";

const opts = {
  repoRoot: "<REPO_ROOT>",
  cacheDir: "<CACHE_DIR>",   // 省略時は <repoRoot>/cache
  minConfidence: 0.5,        // 省略時は 0（全件返す）
};
```

### intent_tags を取得

```typescript
// 全件
const allIntents = await queryIntents(undefined, opts);

// 特定の unit/symbol の intent
const unitIntents = await queryIntents("unit:go:.", opts);
const symIntents  = await queryIntents("sym:go:main#Foo#func()", opts);
```

### summaries を取得

```typescript
const allSummaries  = await querySummaries(undefined, opts);
const unitSummaries = await querySummaries("unit:go:.", opts);
```

### bug_smells を取得

```typescript
// 全件
const allSmells = await querySmells(undefined, opts);

// ファイル絞り込み
const fileSmells = await querySmells({ fileId: "file:main.go" }, opts);

// 重要度絞り込み
const highSmells = await querySmells({ severity: "high" }, opts);

// 複合フィルタ
const filtered = await querySmells({ fileId: "file:main.go", severity: "medium" }, opts);
```

### pattern_tags を取得

```typescript
const allPatterns     = await queryPatterns(undefined, opts);
const factoryPatterns = await queryPatterns("factory", opts);
```

### naming_issues を取得

```typescript
const allIssues = await queryNaming(undefined, opts);
const symIssues = await queryNaming("sym:go:main#Foo#func()", opts);
```

## 出力形式

各関数は対応する型の配列を返す。例：

```typescript
// IntentTag
{ target_id, target_kind, intent, reasoning, meta: { model, confidence, generated_at } }

// BugSmell
{ file_id, position, smell, message, severity, meta }

// NamingIssue
{ symbol_id, issue, current_name, suggestion?, message, meta }
```

詳細な型定義は `core/schema/types.ts` の §14 を参照。

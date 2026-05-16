# compare-facts

2 つの facts スナップショットを diff し、何が変わったかを返す。

---

## 概要

「ある時点」と「別の時点」のキャッシュディレクトリを比較し、以下のカテゴリで追加/削除/変更を列挙する:

- `units` — 追加・削除された解析単位
- `files` — 追加・削除・変更（hash 差分）
- `deps` — 追加・削除された依存
- `symbols` — 追加・削除されたシンボル
- `diagnostics` — 追加・削除・変更（同じ位置・tool で severity/message が異なるもの）

オプションで「ファイル変更が deps グラフ経由でどの unit まで波及するか」（impact）も返せる。コードレビュー・PR コメント・回帰分析の補助に使う。

## API

```typescript
import { compareFacts, summarizeCompare } from "./skills/compare.ts";

const result = await compareFacts({
  baseCacheDir: "/path/to/cache-main",
  headCacheDir: "/path/to/cache-feature",
  includeImpact: true,
});

console.log(summarizeCompare(result));
// units: +1 / -0
// files: +2 / -0 (modified 1)
// deps: +1 / -0
// symbols: +5 / -2
// diagnostics: +0 / -1 (changed 0)
// impact: 3 units
```

### CompareOptions

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `baseCacheDir` | `string` | Yes | 比較元の `cache/` ディレクトリ |
| `headCacheDir` | `string` | Yes | 比較先の `cache/` ディレクトリ |
| `includeImpact` | `boolean` | No | true で `impact.affectedUnits` を埋める（default: false） |

### CompareResult

| フィールド | 型 |
|---|---|
| `units.added` / `units.removed` | `Unit[]` |
| `files.added` / `files.removed` / `files.modified` | `File[]` |
| `deps.added` / `deps.removed` | `Dep[]` |
| `symbols.added` / `symbols.removed` | `Symbol[]` |
| `diagnostics.added` / `diagnostics.removed` | `Diagnostic[]` |
| `diagnostics.changed` | `Array<{ before: Diagnostic; after: Diagnostic }>` |
| `impact?.affectedUnits` | `string[]` （`includeImpact: true` 時のみ） |

## 比較キー

- **Unit**: `id`
- **File**: `id`（path ベース）。`hash` が異なれば `modified`。
- **Dep**: `(from_unit_id, to_unit_id, kind)` の三つ組
- **Symbol**: `id`（unit + 名前 + シグネチャを内包）
- **Diagnostic**: `(tool, file_id, line, column)` で同一性判定し、`message`/`severity` 差で `changed`

## 典型ワークフロー

1. ベースブランチをチェックアウトし `indexFacts({ repoRoot, cacheDir: "cache-base" })` を実行
2. 機能ブランチをチェックアウトし `indexFacts({ repoRoot, cacheDir: "cache-head" })` を実行
3. `compareFacts({ baseCacheDir: "cache-base", headCacheDir: "cache-head", includeImpact: true })`

CI に組み込めば PR の度に「追加された diagnostic」「変更によって影響を受ける unit」をコメントできる。

## 依存

- `core/storage`: facts の読み込み
- `core/diff`: `impactUnits`（`includeImpact` 利用時のみ）

## 実装

### 配置先

- スキル実装: `skills/compare.ts`
- テスト: `skills/compare.test.ts`

### 処理

1. `readFactsPartial` で `units`/`files`/`deps`/`symbols`/`diagnostics` のみ両方のキャッシュから読み込む。
2. それぞれの比較キーで Map 化し、片側にしか無いものを `added`/`removed` に振り分ける。
3. `diagnostics` だけは同一キーで `severity`/`message` が変わった場合に `changed` として分類する。
4. `includeImpact` が true なら、ファイルレベル変更を `impactUnits()` で unit に解決し、head 側 deps グラフを逆引きして推移的に展開する。

### エラーハンドリング

- どちらかのキャッシュに facts が無い: `"No cached facts found at <dir>. Run index-facts there first."` をスロー。

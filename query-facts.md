# query-facts

生成済み facts に対してクエリを実行し、依存関係・定義・参照・診断を取得する。

---

## 概要

AI がコード変更の影響範囲や関連コードを理解するために、facts をクエリする。SPEC.md §9.2 で定義された必須クエリを提供。

## SPEC.md 参照

- セクション: §9.2 Query（MUST）
- 関連要件:
  - §10 クエリ仕様 — 大規模対応のための派生インデックス

## API

```typescript
import {
  queryDeps,
  queryRdeps,
  queryDefs,
  queryRefs,
  queryDiagnostics,
  queryImpact,
  queryImpls,
  queryCallers,
  queryCallees,
} from "./skills/query.ts";

const opts = { repoRoot: "/path/to/repo", cacheDir: "/path/to/cache" };
```

### QueryOptions（共通）

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `repoRoot` | `string` | Yes | リポジトリルートパス |
| `cacheDir` | `string` | No | キャッシュディレクトリ（default: `<repoRoot>/cache`） |

### クエリ関数一覧

#### `queryDeps(unitId, opts) → DepsResult`

指定 unit が依存する unit のリスト。

```typescript
const { deps } = await queryDeps("unit:go:internal/service", opts);
// deps: Dep[] — from_unit_id が unitId に一致する依存
```

#### `queryRdeps(unitId, opts) → RdepsResult`

指定 unit に依存する unit のリスト（逆引き）。

```typescript
const { rdeps } = await queryRdeps("unit:go:pkg/auth", opts);
// rdeps: Dep[] — to_unit_id が unitId に一致する依存
```

#### `queryDefs(query, opts) → DefsResult`

シンボル検索（名前/パス/ID）。

```typescript
// 名前検索
const { symbols } = await queryDefs("CreateUser", opts);

// 複合検索
const { symbols } = await queryDefs({ name: "CreateUser", path: "service" }, opts);

// ID 検索
const { symbols } = await queryDefs({ id: "sym:go:..." }, opts);
```

#### `queryRefs(symbolId, opts) → RefsResult`

指定シンボルへの参照リスト。

```typescript
const { refs } = await queryRefs("sym:go:internal/service#func#CreateUser#sig:0", opts);
// refs: Ref[] — to_symbol_id が symbolId に一致する参照
```

#### `queryDiagnostics(scope, opts) → DiagnosticsResult`

診断情報（scope: repo/unit/file）。

```typescript
// リポジトリ全体
const { diagnostics } = await queryDiagnostics("repo", opts);

// unit スコープ
const { diagnostics } = await queryDiagnostics({ unit: "unit:go:pkg" }, opts);

// file スコープ
const { diagnostics } = await queryDiagnostics({ file: "main.go" }, opts);
```

#### `queryImpact(changedFiles, opts) → ImpactResult`

変更ファイルから影響を受ける unit と関連 deps を返す。

```typescript
const { affectedUnits, affectedDeps } = await queryImpact(["main.go"], opts);
```

#### `queryImpls(typeId, opts) → ImplsResult`

指定した interface を実装する型の一覧。

```typescript
const { implementations } = await queryImpls("sym:go:pkg#type#Repository#sig:0", opts);
```

#### `queryCallers(symbolId, opts) → CallersResult`

指定した関数を呼び出している関数の一覧。

```typescript
const { callers } = await queryCallers("sym:go:pkg#func#Create#sig:0", opts);
```

#### `queryCallees(symbolId, opts) → CalleesResult`

指定した関数から呼び出されている関数の一覧。

```typescript
const { callees } = await queryCallees("sym:go:pkg#func#Handle#sig:0", opts);
```

## 依存

- `core/storage`: facts の読み込み
- `core/diff`: impact 分析（`impactUnits`）

## 実装

### 配置先

- スキル実装: `skills/query.ts`
- テスト: `skills/query.test.ts`

### 処理

各関数は `readFacts()` → メモリ上でフィルタ。MVP では派生インデックス不要。

### エラーハンドリング

- `cache/facts.json` 不在: `"No cached facts found. Run index-facts first."` をスロー
- 不正な unit_id/symbol_id: 空リストを返却

## MVP 制約

現在の Go アダプタは symbols, refs, type_relations, call_edges を空配列で返すため、以下のクエリは空結果になる:
- `queryDefs` — 名前検索は空
- `queryRefs` — 参照なし
- `queryImpls` — 型関係なし
- `queryCallers` / `queryCallees` — コールグラフなし

gopls 統合後に有効になる。

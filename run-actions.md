# run-actions

コードのフォーマット・チェック・テストを実行する。

---

## 概要

コード変更の安全性を担保するため、言語別のアクション（format/check/test）を実行する。SPEC.md §9.4 で定義された必須アクション。

## SPEC.md 参照

- セクション: §9.4 Action（MUST）
- 関連要件:
  - §8.2 ActionAdapter — format/check/test インターフェース

## API

```typescript
import { runAction } from "./skills/actions.ts";

const result = await runAction({
  repoRoot: "/path/to/repo",
  action: "check",           // "format" | "check" | "test"
  scope: { kind: "repo" },   // Scope
  profile: {},                // optional
});
// result: { ok, results, errors }
```

### ActionOptions

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `repoRoot` | `string` | Yes | リポジトリルートパス |
| `action` | `"format" \| "check" \| "test"` | Yes | 実行するアクション |
| `scope` | `Scope` | Yes | 実行範囲 |
| `profile` | `Record<string, string>` | No | ビルドプロファイル |

### Scope

```typescript
| { kind: "repo" }                  // リポジトリ全体
| { kind: "unit"; unitId: string }  // 特定 unit
| { kind: "files"; paths: string[] } // 特定ファイル
| { kind: "paths"; globs: string[] } // glob パターン
```

### ActionRunResult

| フィールド | 型 | 説明 |
|---|---|---|
| `ok` | `boolean` | 全アクションが成功したか |
| `results` | `Array<{ lang, action, result: ActionResult }>` | 言語別の実行結果 |
| `errors` | `string[]` | アダプタ実行時のエラー |

### ActionResult（各言語の結果）

| フィールド | 型 | 説明 |
|---|---|---|
| `ok` | `boolean` | 成功/失敗 |
| `stdout` | `string` | 標準出力 |
| `stderr` | `string` | 標準エラー |
| `exit_code` | `number` | 終了コード |

## 依存

- `skills/registry`: アダプタ登録
- `adapters/<lang>`: 各言語アダプタ（ActionAdapter）

## 実装

### 配置先

- スキル実装: `skills/actions.ts`
- テスト: `skills/actions.test.ts`

### 処理フロー

1. **言語検出** — `registry.detectAll(repoRoot)` で対応言語を検出
2. **ActionAdapter 取得** — 各言語の ActionAdapter を取得（なければスキップ）
3. **アクション実行** — scope に応じて `format()` / `check()` / `test()` を実行
4. **結果集約** — 全言語の結果をまとめて返却

### エラーハンドリング

- ActionAdapter 未登録: 該当言語をスキップ（エラーにはならない）
- アクション実行例外: errors に記録し、他の言語は継続

## アクション別仕様

### format

コードを自動整形する。

- Go: `go fmt <targets>`

### check

静的チェック（build + lint）を実行する。

- Go: `go build <targets>` → `go vet <targets>`

### test

テストを実行する。

- Go: `go test <targets>`

## 使用例

```typescript
import { runAction } from "./skills/actions.ts";

// リポジトリ全体のチェック
const check = await runAction({
  repoRoot: "/path/to/repo",
  action: "check",
  scope: { kind: "repo" },
});

// 特定ファイルのフォーマット
const fmt = await runAction({
  repoRoot: "/path/to/repo",
  action: "format",
  scope: { kind: "files", paths: ["/path/to/repo/main.go"] },
});

// 特定 unit のテスト
const test = await runAction({
  repoRoot: "/path/to/repo",
  action: "test",
  scope: { kind: "unit", unitId: "internal/service" },
});
```

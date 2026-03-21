# bootstrap-tools

検出された言語に必要な解析ツールを自動インストールする。

---

## 概要

`doctor()` が「ツールが足りない」と報告した場合、`bootstrap()` を実行して不足ツールを自動インストールする。Go の場合は `go install` で gopls/staticcheck/errcheck/gosec/govulncheck を導入する。

## SPEC.md 参照

- セクション: §8.1 LanguageAdapter
- 関連要件:
  - §7.1 degrade — ツール未導入時はスキップ（bootstrap はこれを予防する）

## API

```typescript
import { bootstrapTools } from "./skills/bootstrap.ts";

const result = await bootstrapTools({ repoRoot: "/path/to/repo" });
// result: { ok, results: { go: { installed, failed, notes } }, errors }
```

### BootstrapOptions

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `repoRoot` | `string` | Yes | リポジトリルートパス |

### BootstrapAllResult

| フィールド | 型 | 説明 |
|---|---|---|
| `ok` | `boolean` | エラーなしで完了したか |
| `results` | `Record<string, BootstrapResult>` | 言語ごとのインストール結果 |
| `errors` | `string[]` | 致命的エラー |

### BootstrapResult (per language)

| フィールド | 型 | 説明 |
|---|---|---|
| `installed` | `string[]` | インストール成功したツール名 |
| `failed` | `Array<{ tool, reason }>` | 失敗したツールと理由 |
| `notes` | `string[]` | 情報メッセージ（既にインストール済み等） |

## Go アダプタのインストール対象

| ツール | パッケージ | 用途 |
|---|---|---|
| `gopls` | `golang.org/x/tools/gopls@latest` | LSP（symbols/refs/call_edges/type_relations） |
| `staticcheck` | `honnef.co/go/tools/cmd/staticcheck@latest` | 高度な静的解析 |
| `errcheck` | `github.com/kisielk/errcheck@latest` | 未チェックエラー検出 |
| `gosec` | `github.com/securego/gosec/v2/cmd/gosec@latest` | セキュリティ解析 |
| `govulncheck` | `golang.org/x/vuln/cmd/govulncheck@latest` | 依存脆弱性スキャン |

## index-facts との統合

`index-facts` は doctor チェックが失敗した場合に自動で `bootstrap()` を呼び出し、ツールインストール後に再チェックする。明示的に `bootstrapTools()` を呼ぶ必要は通常ない。

## 実装

### 配置先

- スキル実装: `skills/bootstrap.ts`
- アダプタ実装: `adapters/go/language-adapter.ts` の `bootstrap()` メソッド

### 処理フロー

1. `detectAll()` で言語を検出
2. 各言語の `bootstrap()` を実行
3. 結果を集約して返却

### エラーハンドリング

- `go` 未インストール: `failed` に記録、他のツールのインストールは不可
- 個別ツールのインストール失敗: `failed` に理由付きで記録、他は継続
- PATH 未設定: `notes` に `GOPATH/bin` を PATH に追加する手順を記載

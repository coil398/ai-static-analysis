# Go アダプタ仕様 (GO_SPEC.md)

本書は Go 言語アダプタ固有の仕様を定義する。共通インターフェースは SPEC.md §8 を参照。

---

## 1. 使用ツール

| ツール | 用途 | 必須 |
|---|---|---|
| `go` | パッケージ列挙・ビルド・テスト | MUST |
| `gopls` | LSP 経由の symbols/refs/type_relations（将来） | SHOULD |
| `go vet` | 静的診断 | MUST |
| `go fmt` | フォーマット（`go fmt` 経由で `gofmt` を呼び出す） | MUST |

`doctor()` で `go` と `gopls` の存在を確認する。`go` が無い場合は `ok: false`。

---

## 2. Unit マッピング

Go の解析単位は **package**。

```
Unit {
  id:   "unit:go:<relative_path>"     // e.g. "unit:go:internal/service"
  kind: "go_package"
  name: "<package_name>"              // e.g. "service"
  path: "<relative_path>"             // e.g. "internal/service"
  metadata: {
    import_path: "<full_import_path>" // e.g. "example.com/app/internal/service"
    module: "<module_path>"           // e.g. "example.com/app"
  }
}
```

---

## 3. ID 規約

| エンティティ | フォーマット | 例 |
|---|---|---|
| Unit | `unit:go:<path>` | `unit:go:internal/service` |
| File | `file:<path>` | `file:internal/service/user.go` |
| Symbol | `sym:go:<path>#<kind>#<name>#sig:<hash>` | `sym:go:internal/service#func#CreateUser#sig:a1b2` |

Symbol の `sig:<hash>` はシグネチャ文字列の SHA-256 先頭 8 文字。

---

## 4. パッケージ列挙: `go list -json`

```bash
go list -json ./...
```

出力は NDJSON（連結 JSON）。各オブジェクトを順次パースする。

利用フィールド:
- `Dir`: パッケージディレクトリ（絶対パス）
- `ImportPath`: 完全インポートパス
- `Name`: パッケージ名
- `GoFiles`: Go ソースファイル一覧
- `Imports`: インポート先パッケージ一覧
- `Module.Path`: モジュールパス
- `Module.Dir`: モジュールルートディレクトリ
- `Standard`: stdlib かどうか

---

## 5. 依存解決方針

- **リポジトリ内パッケージのみ** を deps として記録する
- stdlib（`Standard: true`）はスキップ
- 外部依存（モジュールパスがリポジトリモジュールと異なる）はスキップ
- `kind: "import"` で記録

---

## 6. Generated file 判定

ファイル先頭を読み取り、以下のコメントが含まれるかを検査:

```
// Code generated
```

Go の公式規約（`go generate` が出力するヘッダ）に従う。
`file.generated = true` を設定。

---

## 7. Diagnostics: `go vet`

```bash
go vet ./...
```

出力フォーマット（stderr）:
```
<file>:<line>:<column>: <message>
```

パースして `Diagnostic` に変換:
- `severity`: すべて `"warning"`（go vet はエラーレベルを区別しない）
- `tool`: `"go_vet"`

---

## 8. ActionAdapter

| アクション | コマンド |
|---|---|
| `format` | `go fmt <targets>` |
| `check` | `go build ./...` + `go vet ./...` |
| `test` | `go test <targets>` |

### Scope → Go コマンド引数

| Scope | 引数 |
|---|---|
| `repo` | `./...` |
| `unit` | `./<path>/...` |
| `files` | 各ファイルパス直接 |
| `paths` | 各 glob パターン |

---

## 9. Fingerprint: build_profile

Go 固有のキーを `build_profile` に含める:

| キー | 取得方法 |
|---|---|
| `GOOS` | `go env GOOS` |
| `GOARCH` | `go env GOARCH` |
| `GOTAGS` | `go env GOTAGS`（空の場合は `""`） |

---

## 10. MVP スコープと将来計画

### MVP（現在）

以下を実装:
- `detect`: go.mod 存在チェック
- `doctor`: go, gopls の存在確認
- `enumerateUnits`: `go list -json` → Unit[]
- `indexUnits`: units/files/deps のみ生成
- `diagnose`: `go vet` → Diagnostic[]
- ActionAdapter: format/check/test

以下は **degrade（空配列を返す）**:
- `symbols`
- `refs`
- `type_relations`
- `call_edges`

### 将来

`gopls` LSP 連携により以下を実装:
- symbols: `textDocument/documentSymbol`
- refs: `textDocument/references`
- type_relations: `textDocument/implementation`
- call_edges: `callHierarchy/incomingCalls` + `outgoingCalls`

# Go アダプタ仕様 (GO_SPEC.md)

本書は Go 言語アダプタ固有の仕様を定義する。共通インターフェースは SPEC.md §8 を参照。

---

## 1. 使用ツール

| ツール | 用途 | 必須 |
|---|---|---|
| `go` | パッケージ列挙・ビルド・テスト | MUST |
| `gopls` | CLI 経由の symbols/refs/type_relations/call_edges | SHOULD |
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
    repo_root: "<absolute_path>"     // e.g. "/home/user/myproject" (indexUnits で必要)
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

全メソッドは `repoRoot` を第一引数に受け取り、Go コマンドの `cwd` として使用する。

| アクション | コマンド |
|---|---|
| `format` | `go fmt <targets>` |
| `check` | `go build <targets>` + `go vet <targets>` |
| `test` | `go test <targets>` |

### Scope → Go コマンド引数

| Scope | 引数 |
|---|---|
| `repo` | `./...` |
| `unit` | `./<path>/...`（`unitId` から `unit:go:` プレフィックスを除去してパスを抽出） |
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

## 10. gopls CLI 連携

`gopls` がインストールされている場合、`indexUnits` は以下のデータを自動取得する。
`gopls` が無い場合は空配列にdegrade（動作に影響なし）。

### 10.1 symbols: `gopls symbols <file>`

出力フォーマット:
```
<name> <Kind> <line>:<col>-<endLine>:<endCol>
	<childName> <Kind> <line>:<col>-<endLine>:<endCol>
```

- 各ファイルに対して実行し、Symbol を生成
- Kind マッピング: `Function→function`, `Method→method`, `Struct→struct`, `Interface→interface`, `Field→field`, `Variable→variable`, `Constant→constant`
- メソッドは `(*Receiver).MethodName` 形式で返される
- `exported` は名前の先頭文字が大文字かで判定
- Symbol ID: `sym:go:<unit_path>#<kind>#<name>#sig:<sha256_8>`

### 10.2 call_edges: `gopls call_hierarchy <file>:<line>:<col>`

出力フォーマット:
```
incoming[N]: function <name> in <file>:<line>:<col>-<endCol>
identifier: function <name> in <file>:<line>:<col>-<endCol>
callee[N]: ranges <line>:<col>-<endCol> in <file> from/to function <name> in <file>:<line>:<col>-<endCol>
```

- 各 function/method シンボルに対して実行
- callee の定義位置から symbolByPos を逆引きして callee の Symbol ID を解決
- リポ内 unit に属さない callee（stdlib 等）はスキップ
- `dispatch`: 現在は全て `"static"`（将来 interface dispatch の判定を追加予定）
- 各 call_edge から `kind: "call"`, `confidence: "certain"` の Ref も同時生成

### 10.3 type_relations: `gopls implementation <file>:<line>:<col>`

出力フォーマット:
```
/path/to/file.go:<line>:<col>-<endCol>
```

- 各 Interface シンボルに対して実行
- 返された位置から symbolByPos を逆引きして実装型の Symbol ID を解決
- `kind: "implements"` の TypeRelation を生成

### 10.4 パフォーマンス考慮

現在は各コマンド呼び出しで gopls プロセスを起動するため、ファイル数×シンボル数に比例した起動コストが発生する。
将来的には `gopls serve` で LSP サーバーを1プロセス起動し、JSON-RPC で通信する方式に移行してパフォーマンスを改善する。

## 11. 実装状態サマリ

| 機能 | 状態 | ツール |
|---|---|---|
| `detect` | 実装済 | go.mod 存在チェック |
| `doctor` | 実装済 | go + オプションツール6種の存在確認、bootstrap ヒント |
| `bootstrap` | 実装済 | `go install` で gopls/staticcheck/errcheck/gosec/govulncheck/dupl を自動インストール |
| `enumerateUnits` | 実装済 | `go list -json` |
| `indexUnits` (units/files/deps) | 実装済 | `go list -json` |
| `indexUnits` (symbols) | 実装済 | `gopls` LSP `documentSymbol` |
| `indexUnits` (refs: call) | 実装済 | `gopls` LSP `callHierarchy` から導出 |
| `indexUnits` (refs: type_ref/field_access) | 実装済 | `gopls` LSP `textDocument/references` |
| `indexUnits` (call_edges) | 実装済 | `gopls` LSP `callHierarchy` |
| `indexUnits` (type_relations) | 実装済 | `gopls` LSP `implementation` |
| `diagnose` (go vet) | 実装済 | `go vet` |
| `diagnose` (staticcheck) | 実装済 | `staticcheck -f json`（オプション、未インストール時degrade） |
| `diagnose` (errcheck) | 実装済 | `errcheck -abspath`（オプション、未インストール時degrade） |
| `diagnose` (循環依存検出) | 実装済 | deps グラフ DFS（常時実行） |
| `diagnose` (gosec) | 実装済 | `gosec -fmt=json`（オプション、未インストール時degrade） |
| `diagnose` (govulncheck) | 実装済 | `govulncheck -json`（オプション、未インストール時degrade） |
| `diagnose` (dupl) | 実装済 | `dupl -plumbing -threshold 50`（オプション、未インストール時degrade） |
| ActionAdapter | 実装済 | `go fmt` / `go build` + `go vet` / `go test` |

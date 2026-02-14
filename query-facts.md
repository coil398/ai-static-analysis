# query-facts

生成済み facts に対してクエリを実行し、依存関係・定義・参照・診断を取得する。

---

## 概要

AI がコード変更の影響範囲や関連コードを理解するために、facts をクエリする。SPEC.md §9.2 で定義された必須クエリを提供。

## SPEC.md 参照

- セクション: §9.2 Query（MUST）
- 関連要件:
  - §10 クエリ仕様 — 大規模対応のための派生インデックス

## 入力

クエリ種別に応じて異なる：

- `deps(unit_id)`: 指定 unit が依存する unit のリスト
- `rdeps(unit_id)`: 指定 unit に依存する unit のリスト（逆引き）
- `defs(symbol_query)`: シンボル検索（名前/パス/ID）
- `refs(symbol_id)`: 指定シンボルへの参照リスト
- `diagnostics(scope)`: 診断情報（scope: unit/file/repo）
- `impact(changed_files)`: 変更ファイルから影響を受ける unit/symbol 候補

## 出力

クエリ結果（JSON 形式）。各クエリの出力例：

```json
// deps(unit_id)
{"deps": ["unit:go:internal/db", "unit:go:pkg/auth"]}

// rdeps(unit_id)
{"rdeps": ["unit:go:internal/handler", "unit:go:cmd/server"]}

// defs(symbol_query)
{"symbols": [{"id": "sym:...", "name": "CreateUser", ...}]}

// refs(symbol_id)
{"refs": [{"from_symbol_id": "...", "site": {...}, "kind": "call"}]}

// diagnostics(scope)
{"diagnostics": [{"file_id": "...", "severity": "warning", ...}]}

// impact(changed_files)
{"affected_units": [...], "affected_symbols": [...]}
```

## 依存

- `core/storage`: facts の読み込み
- `core/query`: クエリエンジン（派生インデックス利用）

## 実装

### 配置先

- スキル実装: `skills/query/`
- コア依存: `core/storage/`, `core/query/`

### 実装言語

言語不問（index-facts と同じ言語を推奨）

### 処理フロー

#### 共通フロー

1. **Facts の読み込み**
   - `cache/facts.json` を読み込む
   - 派生インデックス（あれば）も読み込む

2. **クエリ実行**
   - 各クエリ種別に応じた処理

3. **結果の返却**
   - JSON 形式で返却

#### クエリ別処理

**deps(unit_id)**
1. facts.deps から `from_unit_id == unit_id` を抽出
2. `to_unit_id` のリストを返却

**rdeps(unit_id)**
1. facts.deps から `to_unit_id == unit_id` を抽出
2. `from_unit_id` のリストを返却

**defs(symbol_query)**
1. symbol_query のタイプを判定（name/path/id）
2. facts.symbols から該当するものを検索
3. マッチした symbols を返却

**refs(symbol_id)**
1. facts.refs から `to_symbol_id == symbol_id` を抽出
2. refs のリストを返却

**diagnostics(scope)**
1. scope に応じてフィルタ（unit_id/file_id/全体）
2. facts.diagnostics から該当するものを返却

**impact(changed_files)**
1. changed_files から file_id のリストを生成
2. files → unit_id のマッピングで影響 units を特定
3. symbols.decl.file_id から影響 symbols を特定
4. 両方を返却

### エラーハンドリング

- cache/facts.json 不在: エラーメッセージ「index-facts を先に実行してください」
- 不正な unit_id/symbol_id: 空リストを返却
- クエリ構文エラー: エラーメッセージと使用例を返却

## テスト方針

- Unit テスト: 各クエリロジックの正確性
- Integration テスト: 実 facts.json でのクエリ実行
- Performance テスト: 大規模 facts でのクエリ速度計測

## 使用例

### deps クエリ

```bash
# internal/service が依存する unit を取得
./skills/query/run.sh deps --unit "unit:go:internal/service"

# 出力:
# {
#   "deps": [
#     "unit:go:internal/db",
#     "unit:go:pkg/auth",
#     "unit:go:pkg/logger"
#   ]
# }
```

### rdeps クエリ

```bash
# pkg/auth に依存している unit を取得
./skills/query/run.sh rdeps --unit "unit:go:pkg/auth"

# 出力:
# {
#   "rdeps": [
#     "unit:go:internal/service",
#     "unit:go:internal/handler",
#     "unit:go:cmd/server"
#   ]
# }
```

### defs クエリ

```bash
# CreateUser という名前のシンボルを検索
./skills/query/run.sh defs --name "CreateUser"

# 出力:
# {
#   "symbols": [
#     {
#       "id": "sym:go:internal/service#func#CreateUser#sig:...",
#       "name": "CreateUser",
#       "kind": "function",
#       "signature": "func CreateUser(ctx context.Context, u User) error",
#       "exported": true,
#       "decl": {
#         "file_id": "file:internal/service/user.go",
#         "position": {"line": 10, "column": 1}
#       }
#     }
#   ]
# }
```

### refs クエリ

```bash
# CreateUser への参照を取得
./skills/query/run.sh refs --symbol "sym:go:internal/service#func#CreateUser#sig:..."

# 出力:
# {
#   "refs": [
#     {
#       "from_symbol_id": "sym:go:internal/handler#func#HandleCreateUser#sig:...",
#       "to_symbol_id": "sym:go:internal/service#func#CreateUser#sig:...",
#       "site": {
#         "file_id": "file:internal/handler/user.go",
#         "position": {"line": 25, "column": 15}
#       },
#       "kind": "call",
#       "confidence": "certain"
#     }
#   ]
# }
```

### diagnostics クエリ

```bash
# 全診断を取得
./skills/query/run.sh diagnostics --scope repo

# エラーのみフィルタ
./skills/query/run.sh diagnostics --scope repo --severity error
```

### impact クエリ

```bash
# 変更ファイルの影響範囲を取得
./skills/query/run.sh impact --files "internal/service/user.go"

# 出力:
# {
#   "affected_units": ["unit:go:internal/service"],
#   "affected_symbols": [
#     "sym:go:internal/service#func#CreateUser#sig:...",
#     "sym:go:internal/service#func#UpdateUser#sig:..."
#   ]
# }
```

## パフォーマンス最適化

SPEC.md §10 に従い、以下の派生インデックスを生成して高速化可能：

- `cache/index/unit_by_path.json`: unit 検索高速化
- `cache/index/file_to_unit.json`: file → unit マッピング
- `cache/index/symbol_by_name.json`: シンボル名検索高速化
- `cache/index/refs_by_target.json`: refs クエリ高速化（symbol_id → refs）

これらは `index-facts` または `update-facts` 実行時に自動生成される。

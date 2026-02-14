# static-analysis 仕様書（案）
※本書は「各プロジェクトで ./claude/skills/static-analysis に clone して使う」前提で、静的解析基盤（facts生成・更新・クエリ・検証）を実装するための指示書です。

---

## 0. 前提・配置

- `static-analysis` は **独立したGitリポジトリ**である。
- 各プロジェクトで以下に clone して導入する。

  - `.claude/skills/static-analysis/`  （このディレクトリが本レポジトリ）

- 生成物（キャッシュ等）は Git に含めない。
- 実解析は **決定論ツール（LSP/コンパイラ/静的解析器等）** を利用し、AIの推測で代替しない。
- ツールはローカルにインストールされている前提で呼び出す（同梱は原則しない）。

---

## 1. 目的

大規模コードベースに対して、AIが安全に判断・変更できるようにするための「確定事実（facts）」を生成・維持する。

提供価値：
- 依存関係、定義、参照、診断を **再現可能な形式**で出力
- ツール更新やビルド条件差を **fingerprintで検知**し、整合性を保つ
- インクリメンタル更新（差分更新）を可能にし、スケールさせる
- 必要に応じて format/check/test を実行し、変更の安全性を担保する

---

## 2. ディレクトリ構成（レポ内）

```
static-analysis/
├── core/        # 共通コア（スキーマ、fingerprint、dispatcher、ストレージI/O、差分更新）
├── adapters/    # 言語別アダプタ（解析・診断・依存列挙・アクション）
├── skills/      # AIから呼ぶ操作単位（index/update/query/run 等）
├── cache/       # 生成物（必ず .gitignore）
│   ├── fingerprint.json
│   ├── facts.json  # もしくは facts/ 配下に分割（後述）
│   └── logs/
├── docs/
└── SPEC.md      # 本書（この仕様書）
```

### MUST
- `cache/` は必ず `.gitignore`。
- `cache/` は安全に全削除できる（破損・不一致時にwipe可能）。
- レポ（コード）と生成物（cache）を論理分離する。

---

## 3. 実行モデル（コア + アダプタ + スキル）

### 3.1 分離原則
- **インターフェース（契約）**：共通化し `core/` に定義する
- **実装**：言語別に `adapters/<lang>/` に持つ
- **スキル**：共通名の操作として `skills/` から呼べるようにする（内部で言語別にディスパッチ）

### 3.2 解析単位（Unit）抽象
言語差を吸収するため、コアでは `Unit` を抽象化する。
- Go: package
- TS: tsconfig project
- Python: package/module（環境・ロックに依存）

`Unit.kind` と `Unit.metadata` で差異を表現する。

---

## 4. Fingerprint（整合性ルール）

### 4.1 fingerprint.json（必須）
インデックス生成物には、解析に影響する条件を必ず記録する。

保存項目（MUST）：
- `schema_version`
- `tools`：使用ツールの version 文字列（`--version` の生出力でよい）
- `build_profile`：解析条件（OS/arch/tags、言語別条件を key-value で）
- `repo_state`：対象コードの状態（commit hash もしくは working tree hash）
- `created_at`

例：
```json
{
  "schema_version": 1,
  "tools": {
    "go": "go version go1.22.1",
    "gopls": "gopls v0.15.0",
    "node": "v22.3.0",
    "pyright": "pyright 1.1.370"
  },
  "build_profile": {
    "GOOS": "darwin",
    "GOARCH": "arm64",
    "GOTAGS": "",
    "TS_CONFIG": "tsconfig.json",
    "PY_ENV": "poetry"
  },
  "repo_state": {
    "commit": "abcdef1234",
    "working_tree_hash": "optional"
  },
  "created_at": "2026-02-14T00:00:00+09:00"
}
```

### 4.2 再構築ルール（MUST）
実行時に現在環境のfingerprintを生成し、`cache/fingerprint.json`と比較する。

**不一致の場合：**
- 差分更新は禁止
- `cache/`をwipeしてフル再構築

**一致の場合：**
- 差分更新を許可する

---

## 5. Facts（静的解析結果）フォーマット

### 5.1 ストレージ形式
生成物は`cache/`内に保存する。

フォーマットはJSONとし、以下のどちらでもよい（実装で選択）：
- **単一ファイル**：`cache/facts.json`
- **分割**：`cache/facts/*.jsonl`（大規模向け、後述）

### 5.2 P0（必須）データモデル
AIが大規模でも安全に判断できる最小セットとして、以下をMUSTで実装する。

- **units**：解析単位
- **files**：ファイルと所属unit
- **deps**：unit間依存（import/include/project ref 等）
- **symbols**：定義（関数/型/メソッド等）
- **refs**：参照（from→to）
- **type_relations**：型関係（implements/embeds/converts_to/instantiates）
- **call_edges**：コールグラフ（caller→callee、dispatch種別付き）
- **diagnostics**：診断（error/warn/info）

#### 共通要件（MUST）
- 各要素は**安定ID**を持つ（差分更新・参照整合のため）
  - 例：`<unit_path>#<kind>#<name>#<signature_hash>` 等
- `position`は最低限 `file + (line, column)` を保持し、可能なら`byte_offset`も保持する
- `file.hash`は差分検知のため必須（sha256推奨）

---

## 6. facts.json スキーマ（案）

### 6.1 トップレベル
```json
{
  "schema_version": 1,
  "snapshot": {
    "commit": "abcdef1234",
    "created_at": "2026-02-14T00:00:00+09:00"
  },
  "units": [],
  "files": [],
  "deps": [],
  "symbols": [],
  "refs": [],
  "type_relations": [],
  "call_edges": [],
  "diagnostics": [],
  "meta": {
    "generator": "static-analysis",
    "notes": ""
  }
}
```

### 6.2 Units
```json
{
  "id": "unit:go:internal/service",
  "kind": "go_package",
  "name": "service",
  "path": "internal/service",
  "metadata": {
    "module": "example.com/app"
  }
}
```

### 6.3 Files
```json
{
  "id": "file:internal/service/user.go",
  "path": "internal/service/user.go",
  "unit_id": "unit:go:internal/service",
  "hash": "sha256:...",
  "generated": false
}
```

### 6.4 Deps（Unit依存）
```json
{
  "from_unit_id": "unit:go:internal/service",
  "to_unit_id": "unit:go:internal/db",
  "kind": "import"
}
```

### 6.5 Symbols
```json
{
  "id": "sym:go:internal/service#func#CreateUser#sig:...",
  "unit_id": "unit:go:internal/service",
  "name": "CreateUser",
  "kind": "function",
  "signature": "func CreateUser(ctx context.Context, u User) error",
  "exported": true,
  "decl": {
    "file_id": "file:internal/service/user.go",
    "position": { "line": 10, "column": 1 }
  },
  "metadata": {
    "receiver": null
  }
}
```

### 6.6 Refs
```json
{
  "from_symbol_id": "sym:go:internal/handler#func#Handle#sig:...",
  "to_symbol_id": "sym:go:internal/service#func#CreateUser#sig:...",
  "site": {
    "file_id": "file:internal/handler/user.go",
    "position": { "line": 42, "column": 12 }
  },
  "kind": "call",
  "confidence": "certain"
}
```

### 6.8 TypeRelations（型関係）
```json
{
  "from_type_id": "sym:go:internal/service#type#UserRepository#sig:...",
  "to_type_id": "sym:go:internal/db#type#Repository#sig:...",
  "kind": "implements"
}
```

- `from_type_id` / `to_type_id`：Symbol の ID を参照する（型はSymbolの一種として管理）
- `kind`：
  - `implements`：interface を満たす（Go の暗黙的 interface 実装等）
  - `embeds`：struct embedding / 継承
  - `converts_to`：型変換可能
  - `instantiates`：ジェネリクスの具体化

### 6.9 CallEdges（コールグラフ）
```json
{
  "caller_id": "sym:go:internal/handler#func#Handle#sig:...",
  "callee_id": "sym:go:internal/service#func#CreateUser#sig:...",
  "site": {
    "file_id": "file:internal/handler/user.go",
    "position": { "line": 42, "column": 12 }
  },
  "dispatch": "static"
}
```

- `dispatch`：
  - `static`：直接呼び出し（関数名で静的に解決）
  - `dynamic`：関数ポインタ / クロージャ経由
  - `interface`：interface メソッド経由（実際の呼び先は `type_relations` の `implements` と組み合わせて展開）

### 6.7 Diagnostics
```json
{
  "file_id": "file:internal/service/user.go",
  "position": { "line": 15, "column": 5 },
  "severity": "warning",
  "message": "unused variable x",
  "tool": "gopls"
}
```

---

## 7. 大規模対応要件（再検討結果：追加 MUST/SHOULD）

### 7.1 MUST（最低限）
- facts生成は**フル再生成**と**差分更新**の両方に対応する
- 差分更新は`changed_files[]`入力を受け取り、影響unitを再解析する
- 解析の失敗（ツール未導入/異常終了）時は、全体を落とさず、該当言語/機能を無効化して継続（degrade）
- 生成コード（generated files）の扱いを定義する
  - `generated: true/false`をfileに持たせる
  - 既定は「解析対象に含める（ただしmetadataで識別可能）」

### 7.2 SHOULD（推奨：重くなったときの逃げ道）
- `facts.json`が巨大になる場合に備え、JSON Lines分割を許容する
  - `cache/facts/units.jsonl`, `files.jsonl`, `symbols.jsonl`, `refs.jsonl`, `type_relations.jsonl`, `call_edges.jsonl`, `diagnostics.jsonl`
- `refs`は件数が爆発しやすいので分割保存を優先する
- `impact`クエリの高速化のため、派生インデックスを生成してよい
  - 例：`cache/index/unit_by_file.json`等（あくまで生成物）

---

## 8. 言語別アダプタ契約（共通インターフェース）

### 8.1 LanguageAdapter（MUST）
各アダプタは以下を実装する（入出力は共通スキーマへ正規化）。

- `detect(repo_root) -> {supported: bool, confidence: 0..1}`
- `enumerate_units(repo_root, profile) -> Unit[]`
- `index_units(units[], profile) -> FactsDelta`
- `diagnose(units[], profile) -> Diagnostic[]`（indexに含めてもよい）
- `doctor() -> {ok: bool, missing_tools: [], notes: []}`

### 8.2 ActionAdapter（MUST）
- `format(scope, profile) -> result`
- `check(scope, profile) -> result`
- `test(scope, profile) -> result`

※ `scope`は`repo|unit|files|paths`いずれかで指定できること。

### 8.3 InsightAdapter（SHOULD — AI非決定論解析）
決定論ツールでは取れない「意味」の層をAIで生成する。
Facts（決定論）とは完全に分離し、`cache/insights.json` に保存する。

- `tag_intents(scope) -> IntentTag[]`
- `summarize(scope) -> Summary[]`
- `detect_bug_smells(scope) -> BugSmell[]`
- `detect_patterns(scope) -> PatternTag[]`
- `review_naming(scope) -> NamingIssue[]`

※ `scope` は `{unit_ids?, symbol_ids?, file_ids?}` で対象を絞れる（省略時は全体）。

#### 設計原則
- **分離**：insights は facts と混ぜない。別ファイル、別クエリ、オプトイン参照
- **トレーサビリティ**：全項目に `meta: {model, confidence, generated_at}` を付与
- **再生成安全**：`cache/insights.json` は安全に全削除できる。モデル更新時は再生成
- **fingerprint 非依存**：insights の有効性は facts の fingerprint とは別管理（モデル変更で invalidate）

---

## 9. Skills（AIから呼ぶ操作単位）

### 9.1 Indexing
**`index(profile)`**：
1. fingerprint比較
2. 不一致ならcache wipe
3. フル解析
4. facts保存

**`update(changed_files, profile)`**：
1. fingerprint一致なら差分更新
2. 不一致なら`index()`にフォールバック

### 9.2 Query（MUST）
- `deps(unit_id)`
- `rdeps(unit_id)`
- `defs(symbol_query)`：名前/パス/ID検索
- `refs(symbol_id)`
- `diagnostics(scope)`
- `impls(type_id)`：指定した interface を実装する型の一覧（type_relations の implements を逆引き）
- `callers(symbol_id)`：指定した関数を呼び出している関数の一覧（call_edges の逆引き）
- `callees(symbol_id)`：指定した関数から呼び出されている関数の一覧
- `impact(changed_files)`：影響unit/symbol候補を返す（type_relations + call_edges を辿って推移的に展開）

### 9.3 Insight（SHOULD — AI非決定論解析）
**`analyze(scope?)`**：
1. facts が存在することを確認（insights は facts に依存）
2. scope 内の unit/symbol/file に対して InsightAdapter を実行
3. `cache/insights.json` に保存

**`query_insights(kind, filter?)`**：
- `intents(target_id?)`：意図タグの一覧・検索
- `summaries(target_id?)`：要約の取得
- `smells(file_id?, severity?)`：バグ臭の一覧
- `patterns(pattern?)`：設計パターンの検索
- `naming(symbol_id?)`：命名問題の一覧

※ クエリ時に `--min-confidence 0.7` のようにしきい値でフィルタ可能。

### 9.4 Action（MUST）
- `run_format(scope, profile)`
- `run_check(scope, profile)`
- `run_test(scope, profile)`

---

## 10. クエリ仕様（最低限）
JSONストア前提なので、P0は「全件ロード→メモリでフィルタ」でもよいが、大規模で破綻する場合に備え以下をSHOULDとする：

- `unit_by_path`、`file_to_unit`、`symbol_by_name`の派生マップ生成
- `refs`はシンボルIDで索引できる形（分割 + 事前索引）を検討

---

## 11. 運用方針
- ツール更新は許容し、fingerprint差で再構築する
- `diagnostics`が増えることは改善として扱う（ただしP1で増分追跡は拡張可能）
- 解析は決定論ツール出力を正とする

---

## 12. MVP（実装順）
1. `cache/`管理、fingerprint生成・比較・wipe・再構築ルール
2. 共通スキーマ（P0）とJSON入出力
3. アダプタ仕組み（detect/doctor/enumerate/index）
4. Goアダプタ（最初の言語）
5. skills: index/update + query（deps/refs/diagnostics/impact）
6. actions: check/test（formatは後でも可）
7. 大規模対応（refs分割、派生索引）を必要に応じて追加
8. AI Insights（InsightAdapter + insights スキーマ + analyze/query スキル）

---

## 13. 禁止事項
- 生成物（cache）をGit管理対象に入れる運用を前提にしない
- AIの推測で`refs`/`defs`/`dep`を捏造しない（必ずツール出力に基づく）
- AI Insights を Facts に混入しない（insights は常に別ファイル・別クエリで管理する）

---

## 14. AI Insights（非決定論解析）

決定論ツールでは取得不可能な「意味」「意図」「品質」の層を AI モデルで生成する。
Facts（決定論的事実）とは完全に分離して管理する。

### 14.1 ストレージ
- 保存先：`cache/insights.json`（facts.json とは別ファイル）
- 安全に全削除できる（facts と独立して再生成可能）
- fingerprint とは別管理。モデル変更時に再生成する

### 14.2 IntentTag（意図タグ）
シンボルや unit に対して「役割」「責務」をラベル付けする。

```json
{
  "target_id": "sym:go:internal/middleware#func#RequireAuth#sig:...",
  "target_kind": "symbol",
  "intent": "auth-guard",
  "reasoning": "Checks JWT token and returns 401 if invalid before calling next handler",
  "meta": { "model": "claude-sonnet-4-5-20250929", "confidence": 0.92, "generated_at": "2026-02-15T00:00:00Z" }
}
```

用途：impact 分析時に「認証に関わる変更」をフィルタできる。

### 14.3 Summary（要約）
関数・モジュール・ファイルの自然言語による要約。

```json
{
  "target_id": "unit:go:internal/service",
  "target_kind": "unit",
  "text": "User CRUD operations with validation. Depends on db package for persistence and auth package for permission checks.",
  "meta": { "model": "claude-sonnet-4-5-20250929", "confidence": 0.88, "generated_at": "2026-02-15T00:00:00Z" }
}
```

用途：シンボル一覧のナビゲーション、コードレビュー時の概要把握。

### 14.4 BugSmell（バグ臭検出）
決定論ツールが検出しない「疑わしいパターン」を AI が指摘する。

```json
{
  "file_id": "file:internal/service/user.go",
  "position": { "line": 45, "column": 2 },
  "smell": "swallowed_error",
  "message": "error from db.Save() is assigned to _ and not propagated or logged",
  "severity": "high",
  "meta": { "model": "claude-sonnet-4-5-20250929", "confidence": 0.85, "generated_at": "2026-02-15T00:00:00Z" }
}
```

smell の種類（拡張可能）：
- `swallowed_error`：エラー握りつぶし
- `nil_check_missing`：nil/null チェック漏れ
- `race_condition`：競合状態の可能性
- `resource_leak`：リソースリーク（close 漏れ等）
- `unchecked_cast`：型アサーション未チェック
- `logic_error`：論理的な矛盾・条件ミス
- `other`

### 14.5 PatternTag（設計パターン検出）
コードベース内の設計パターンを識別する。

```json
{
  "target_id": "unit:go:internal/service",
  "target_kind": "unit",
  "pattern": "repository",
  "participants": ["sym:go:internal/service#type#UserRepository#sig:...", "sym:go:internal/db#type#Repository#sig:..."],
  "meta": { "model": "claude-sonnet-4-5-20250929", "confidence": 0.78, "generated_at": "2026-02-15T00:00:00Z" }
}
```

用途：リファクタリング時の構造理解、一貫性チェック。

### 14.6 NamingIssue（命名品質）
紛らわしい・一貫性のない命名を指摘する。

```json
{
  "symbol_id": "sym:go:internal/service#func#Do#sig:...",
  "issue": "too_generic",
  "current_name": "Do",
  "suggestion": "ProcessUserRequest",
  "message": "Function name 'Do' is too generic for a method that processes user registration requests",
  "meta": { "model": "claude-sonnet-4-5-20250929", "confidence": 0.72, "generated_at": "2026-02-15T00:00:00Z" }
}
```

issue の種類：
- `misleading`：名前と実際の動作が異なる
- `too_abbreviated`：略語が多すぎて読めない
- `inconsistent`：同じコードベース内で命名規則が不統一
- `too_generic`：汎用的すぎて意味が不明
- `other`

### 14.7 共通メタデータ（InsightMeta）
全 insight に必須で付与する。

| フィールド | 型 | 説明 |
|---|---|---|
| `model` | string | 生成に使用したモデル ID |
| `confidence` | number (0..1) | AI の確信度。クエリ時のフィルタに使う |
| `generated_at` | string (ISO 8601) | 生成日時 |

---

## 補足
上の仕様は「JSONで十分」という前提を崩さずに、**大規模で実際に破綻しやすい点（refs爆発、索引、差分更新、generated扱い、degrade、fingerprint）**を仕様側に織り込んであります。

次にこちらで直すべきポイントがあるなら、あなたの言う「不足」や「不要」をそのまま反映して版を更新します。

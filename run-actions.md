# run-actions

コードのフォーマット・チェック・テストを実行する。

---

## 概要

コード変更の安全性を担保するため、言語別のアクション（format/check/test）を実行する。SPEC.md §9.3 で定義された必須アクション。

## SPEC.md 参照

- セクション: §9.3 Action（MUST）
- 関連要件:
  - §8.2 ActionAdapter — format/check/test インターフェース
  - §1 提供価値 — 変更の安全性担保

## 入力

- `action`: 実行するアクション（`format` | `check` | `test`）
- `scope`: 実行範囲（`repo` | `unit:<unit_id>` | `files:<paths>` | `paths:<glob>`）
- `profile`: ビルドプロファイル（オプション）

## 出力

- アクション実行結果
  - `ok`: 成功/失敗
  - `output`: 標準出力/標準エラー
  - `changes`: format の場合、変更されたファイルリスト
  - `errors`: check/test の場合、エラー箇所

## 依存

- `adapters/<lang>`: 各言語アダプタ（ActionAdapter）

## 実装

### 配置先

- スキル実装: `skills/actions/`
- アダプタ依存: `adapters/*/`

### 実装言語

言語不問

### 処理フロー

1. **Scope の解決**
   - scope から対象ファイル・unit を特定
   - `repo`: 全 unit
   - `unit:<unit_id>`: 指定 unit のみ
   - `files:<paths>`: 指定ファイルのみ
   - `paths:<glob>`: glob パターンマッチ

2. **言語別アダプタの選択**
   - 対象ファイル・unit から言語を判定
   - 該当する ActionAdapter を取得

3. **アクション実行**
   - `format(scope, profile)`: コードフォーマット実行
   - `check(scope, profile)`: 静的チェック（lint/type check）実行
   - `test(scope, profile)`: テスト実行

4. **結果の集約**
   - 複数言語にまたがる場合、結果をマージ
   - 失敗があれば全体を失敗とする

### エラーハンドリング

- アダプタ未実装: 該当言語をスキップして警告
- ツール未導入: doctor チェックで検出し、スキップ
- 実行失敗: エラー出力を返し、終了コード非ゼロ

## アクション別仕様

### format

コードを自動整形する。

**ツール例:**
- Go: `gofmt`, `goimports`
- TypeScript: `prettier`
- Python: `black`, `ruff format`

**動作:**
- ファイルを in-place で書き換える
- 変更されたファイルリストを返す
- CI では `--check` モードで差分があれば失敗

### check

静的チェック（lint, type check）を実行する。

**ツール例:**
- Go: `go vet`, `staticcheck`, `golangci-lint`
- TypeScript: `tsc --noEmit`, `eslint`
- Python: `mypy`, `ruff check`

**動作:**
- ファイルを変更しない
- エラー・警告を収集して返す
- エラーがあれば終了コード非ゼロ

### test

テストを実行する。

**ツール例:**
- Go: `go test`
- TypeScript: `jest`, `vitest`
- Python: `pytest`

**動作:**
- テストを実行し、結果を返す
- 失敗があれば終了コード非ゼロ
- カバレッジ取得はオプション

## テスト方針

- Unit テスト: scope 解決ロジック
- Integration テスト: 各言語アダプタとの結合
- E2E テスト: 実プロジェクトでのアクション実行

## 使用例

### format

```bash
# リポジトリ全体をフォーマット
./skills/actions/run.sh format --scope repo

# 特定ファイルのみフォーマット
./skills/actions/run.sh format --scope "files:internal/service/user.go,src/api/user.ts"

# CI での差分チェック
./skills/actions/run.sh format --scope repo --check
# 差分があれば終了コード非ゼロ
```

### check

```bash
# リポジトリ全体をチェック
./skills/actions/run.sh check --scope repo

# 特定 unit のみチェック
./skills/actions/run.sh check --scope "unit:go:internal/service"

# 出力例:
# [Go] internal/service/user.go:15:5: unused variable x
# [TS] src/api/user.ts:42:10: 'userId' is declared but never used
# [ERROR] Check failed with 2 errors
```

### test

```bash
# リポジトリ全体のテスト実行
./skills/actions/run.sh test --scope repo

# 特定 unit のテスト実行
./skills/actions/run.sh test --scope "unit:go:internal/service"

# 変更ファイルに関連するテストのみ実行
changed_files=$(git diff --name-only HEAD)
./skills/actions/run.sh test --scope "files:$changed_files" --related

# 出力例:
# [Go] PASS internal/service (0.5s)
# [TS] PASS src/api (1.2s)
# [SUCCESS] All tests passed
```

### scope の使い分け

```bash
# repo: CI での全体チェック
./skills/actions/run.sh check --scope repo

# unit: 特定パッケージの開発中
./skills/actions/run.sh test --scope "unit:go:internal/service"

# files: コミット前の最終確認
./skills/actions/run.sh format --scope "files:$(git diff --cached --name-only)"

# paths: 特定ディレクトリ配下
./skills/actions/run.sh check --scope "paths:internal/**/*.go"
```

## CI/CD での使用

```yaml
# .github/workflows/ci.yml
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Format check
        run: ./claude/skills/static-analysis/skills/actions/run.sh format --scope repo --check
      - name: Lint
        run: ./claude/skills/static-analysis/skills/actions/run.sh check --scope repo
      - name: Test
        run: ./claude/skills/static-analysis/skills/actions/run.sh test --scope repo
```

## Pre-commit hook での使用

```bash
# .git/hooks/pre-commit
#!/bin/bash
changed_files=$(git diff --cached --name-only)

# 変更ファイルをフォーマット
./claude/skills/static-analysis/skills/actions/run.sh format --scope "files:$changed_files"

# フォーマット結果を再ステージング
git add $changed_files

# 変更ファイルをチェック
./claude/skills/static-analysis/skills/actions/run.sh check --scope "files:$changed_files"
```

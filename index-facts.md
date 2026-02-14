# index-facts

コードベース全体の静的解析を実行し、facts を生成する。

---

## 概要

プロジェクトのすべての解析単位（unit）を列挙し、依存関係・定義・参照・診断を facts として生成する。fingerprint を記録し、次回以降の差分更新を可能にする。

## SPEC.md 参照

- セクション: §9.1 Indexing
- 関連要件:
  - §4 Fingerprint（整合性ルール）— fingerprint 比較・不一致時の cache wipe
  - §5-6 Facts フォーマット — P0 データモデルへの準拠
  - §7.1 MUST — フル再生成対応、degrade 対応

## 入力

- `profile`: ビルドプロファイル（オプション）
  - 例: `{"GOOS": "linux", "GOARCH": "amd64", "TS_CONFIG": "tsconfig.json"}`
  - 省略時はデフォルト環境を使用

## 出力

- `cache/fingerprint.json`: 生成時の環境・ツールバージョン・コミットハッシュ
- `cache/facts.json`: 生成された facts（units, files, deps, symbols, refs, diagnostics）
- ログ: 各言語アダプタの実行結果

## 依存

- `core/fingerprint`: fingerprint 生成・比較
- `core/schema`: facts スキーマ定義
- `core/storage`: JSON 読み書き
- `adapters/<lang>`: 各言語アダプタ（detect, enumerate_units, index_units）

## 実装

### 配置先

- スキル実装: `skills/index/`
- コア依存: `core/fingerprint/`, `core/schema/`, `core/storage/`
- アダプタ依存: `adapters/*/`

### 実装言語

言語不問（最初の実装では Python or TypeScript を推奨）

### 処理フロー

1. **Fingerprint 生成**
   - 現在環境の fingerprint を生成（tools バージョン、build_profile, repo_state）

2. **Fingerprint 比較**
   - `cache/fingerprint.json` が存在する場合は比較
   - 不一致の場合は cache/ を wipe してフル再構築へ
   - 一致の場合でもフル再構築（index は常にフル）

3. **言語検出**
   - 各アダプタの `detect(repo_root)` を実行
   - 検出された言語リストを取得

4. **Doctor チェック**
   - 検出された各言語の `doctor()` を実行
   - ツール未導入の場合は警告して該当言語をスキップ（degrade）

5. **Unit 列挙**
   - 各アダプタの `enumerate_units(repo_root, profile)` を実行
   - すべての unit を収集

6. **Facts 生成**
   - 各アダプタの `index_units(units, profile)` を実行
   - FactsDelta を収集し、マージ

7. **保存**
   - `cache/facts.json` に保存
   - `cache/fingerprint.json` を更新

### エラーハンドリング

- ツール未導入（doctor 失敗）: 該当言語を無効化して継続（SPEC.md §7.1 degrade）
- 一部の unit で解析失敗: 失敗した unit を diagnostics に記録し、他は継続
- 保存失敗: エラーログを出力して終了

## テスト方針

- Unit テスト: fingerprint 生成・比較ロジック
- Integration テスト: 各言語アダプタとの結合（モックアダプタで検証）
- E2E テスト: 実プロジェクトでの index 実行と facts 検証

## 使用例

### 基本的な使用

```bash
# デフォルト環境で index 実行
./skills/index/run.sh

# 結果確認
ls -lh cache/
cat cache/fingerprint.json
jq '.units | length' cache/facts.json
```

### プロファイル指定

```bash
# クロスコンパイル環境で index
./skills/index/run.sh --profile '{"GOOS":"windows","GOARCH":"amd64"}'
```

### 初回実行の流れ

1. cache/ が空の状態で実行
2. fingerprint 生成
3. 言語検出（例: Go, TypeScript 検出）
4. doctor チェック（gopls, typescript-language-server の有無確認）
5. unit 列挙（全パッケージ・プロジェクト列挙）
6. 解析実行（並列 or 順次）
7. facts.json 保存

### 2回目実行の流れ

1. 既存 fingerprint と比較
2. 不一致の場合は cache/ wipe → 初回と同じフル再構築
3. 一致の場合もフル再構築（index は常にフル、差分更新は update-facts で実施）

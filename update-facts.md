# update-facts

変更ファイルのみを再解析し、facts を差分更新する。

---

## 概要

index-facts のフル再構築は時間がかかるため、変更ファイルが少ない場合は差分更新で高速化する。fingerprint 一致時のみ実行可能。

## SPEC.md 参照

- セクション: §9.1 Indexing
- 関連要件:
  - §4.2 再構築ルール — fingerprint 一致時のみ差分更新許可
  - §7.1 MUST — 差分更新対応、changed_files 入力

## 入力

- `changed_files`: 変更されたファイルパスのリスト
  - 例: `["internal/service/user.go", "src/components/User.tsx"]`
  - Git diff から取得するか、手動指定
- `profile`: ビルドプロファイル（オプション、index-facts と同じ）

## 出力

- 更新された `cache/facts.json`
- 更新サマリー（影響を受けた units, symbols, refs の数）

## 依存

- `core/fingerprint`: fingerprint 比較
- `core/schema`: facts スキーマ定義
- `core/storage`: JSON 読み書き
- `core/diff`: 影響 unit の特定、facts のマージ
- `adapters/<lang>`: 各言語アダプタ（index_units）

## 実装

### 配置先

- スキル実装: `skills/update/`
- コア依存: `core/fingerprint/`, `core/schema/`, `core/storage/`, `core/diff/`
- アダプタ依存: `adapters/*/`

### 実装言語

言語不問（index-facts と同じ言語を推奨）

### 処理フロー

1. **Fingerprint チェック**
   - 現在環境の fingerprint を生成
   - `cache/fingerprint.json` と比較
   - 不一致の場合は index-facts にフォールバック

2. **影響 Unit の特定**
   - changed_files から影響を受ける units を特定
   - `core/diff/impact_units(changed_files, facts)` を実行

3. **既存 Facts の読み込み**
   - `cache/facts.json` を読み込む

4. **影響 Unit の再解析**
   - 影響を受けた units のみを再度 `index_units()` で解析
   - FactsDelta を取得

5. **Facts のマージ**
   - 既存 facts から影響 unit の古いデータを削除
   - 新しい FactsDelta をマージ
   - 参照整合性を維持（削除された symbol への refs を無効化）

6. **保存**
   - 更新された facts を `cache/facts.json` に保存
   - fingerprint は変更なし（環境が同じため）

### エラーハンドリング

- Fingerprint 不一致: index-facts にフォールバック（自動）
- cache/facts.json 不在: index-facts にフォールバック
- 一部 unit の解析失敗: 該当 unit を diagnostics に記録し、他は継続

## テスト方針

- Unit テスト: impact_units ロジック、facts マージロジック
- Integration テスト: 差分更新の正確性（フル再構築と結果一致を検証）
- Performance テスト: 大規模リポジトリでの更新時間計測

## 使用例

### Git diff から自動検出

```bash
# 変更ファイルを Git から取得して差分更新
./skills/update/run.sh --auto

# 内部では以下を実行:
# changed_files=$(git diff --name-only HEAD)
# ./skills/update/run.sh --files "$changed_files"
```

### 手動指定

```bash
# 特定ファイルの変更を反映
./skills/update/run.sh --files "internal/service/user.go,src/api/user.ts"
```

### Fingerprint 不一致時の挙動

```bash
# Go のバージョンが変わった場合
$ go version
go version go1.23.0  # 以前は go1.22.1

$ ./skills/update/run.sh --auto
[WARN] Fingerprint mismatch (tools.go changed)
[INFO] Falling back to full index...
# → index-facts が自動実行される
```

### 差分更新の効果

```
# フル index: 120秒
./skills/index/run.sh
# 50 units, 5000 symbols

# 1ファイル変更後の差分更新: 3秒
./skills/update/run.sh --auto
# 1 unit affected, 10 symbols updated
```

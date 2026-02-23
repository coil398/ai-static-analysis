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

## API

```typescript
import { indexFacts } from "./skills/index.ts";

const result = await indexFacts({
  repoRoot: "/path/to/repo",
  cacheDir: "/path/to/cache",  // default: "<repoRoot>/cache"
  profile: { GOOS: "linux" },  // optional
});
// result: { ok, facts, fingerprint, errors, warnings }
```

### IndexOptions

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `repoRoot` | `string` | Yes | リポジトリルートパス |
| `cacheDir` | `string` | No | キャッシュディレクトリ（default: `<repoRoot>/cache`） |
| `profile` | `Record<string, string>` | No | ビルドプロファイル |

### IndexResult

| フィールド | 型 | 説明 |
|---|---|---|
| `ok` | `boolean` | エラーなしで完了したか |
| `facts` | `Facts` | 生成された facts |
| `fingerprint` | `Fingerprint` | 記録された fingerprint |
| `errors` | `string[]` | 致命的エラー |
| `warnings` | `string[]` | 警告（degrade 等） |

## 出力ファイル

- `cache/fingerprint.json`: 生成時の環境・ツールバージョン・コミットハッシュ
- `cache/facts.json`: 生成された facts（units, files, deps, symbols, refs, diagnostics）

## 依存

- `core/fingerprint`: fingerprint 生成・比較
- `core/schema`: facts スキーマ定義
- `core/storage`: JSON 読み書き
- `core/diff`: FactsDelta のマージ
- `skills/registry`: アダプタ登録
- `adapters/<lang>`: 各言語アダプタ（detect, enumerate_units, index_units, diagnose）

## 実装

### 配置先

- スキル実装: `skills/index.ts`
- テスト: `skills/index.test.ts`

### 処理フロー

1. **Fingerprint 生成**
   - 現在環境の fingerprint を生成（tools バージョン、build_profile, repo_state）

2. **Fingerprint 比較**
   - `cache/fingerprint.json` が存在する場合は比較
   - 不一致の場合は cache/ を wipe してフル再構築へ
   - 一致の場合でもフル再構築（index は常にフル）

3. **言語検出**
   - `registry.detectAll(repoRoot)` で検出
   - 検出された言語リストを取得

4. **Doctor チェック**
   - 検出された各言語の `doctor()` を実行
   - ツール未導入の場合は警告して該当言語をスキップ（degrade）

5. **Unit 列挙**
   - 各アダプタの `enumerateUnits(repoRoot, profile)` を実行
   - すべての unit を収集

6. **Facts 生成**
   - 各アダプタの `indexUnits(units, profile)` を実行
   - FactsDelta を `applyDelta()` でマージ

7. **Diagnostics 収集**
   - 各アダプタの `diagnose(units, profile)` を実行

8. **保存**
   - `writeFacts()` + `writeFingerprint()`

### エラーハンドリング

- ツール未導入（doctor 失敗）: 該当言語を無効化して継続（SPEC.md §7.1 degrade）
- 一部の unit で解析失敗: エラーを errors に記録し、他は継続
- 保存失敗: 例外がスローされる

## 使用例

```typescript
import { indexFacts } from "./skills/index.ts";

// デフォルト環境で index 実行
const result = await indexFacts({ repoRoot: "/path/to/repo" });

console.log(`Units: ${result.facts.units.length}`);
console.log(`Files: ${result.facts.files.length}`);
console.log(`Deps: ${result.facts.deps.length}`);
console.log(`Diagnostics: ${result.facts.diagnostics.length}`);

if (!result.ok) {
  console.error("Errors:", result.errors);
}
if (result.warnings.length > 0) {
  console.warn("Warnings:", result.warnings);
}
```

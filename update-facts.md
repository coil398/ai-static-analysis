# update-facts

変更ファイルのみを再解析し、facts を差分更新する。

---

## 概要

index-facts のフル再構築は時間がかかるため、変更ファイルが少ない場合は差分更新で高速化する。fingerprint 一致時のみ実行可能。不一致時は自動で index-facts にフォールバック。

## SPEC.md 参照

- セクション: §9.1 Indexing
- 関連要件:
  - §4.2 再構築ルール — fingerprint 一致時のみ差分更新許可
  - §7.1 MUST — 差分更新対応、changed_files 入力

## API

```typescript
import { updateFacts } from "./skills/update.ts";

const result = await updateFacts({
  repoRoot: "/path/to/repo",
  changedFiles: ["internal/service/user.go", "pkg/auth/auth.go"],
  cacheDir: "/path/to/cache",  // optional
  profile: {},                  // optional
});
// result: { ok, facts, affectedUnits, fallbackToIndex, errors, warnings }
```

### UpdateOptions

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `repoRoot` | `string` | Yes | リポジトリルートパス |
| `changedFiles` | `string[]` | Yes | 変更されたファイルパスのリスト（相対パス） |
| `cacheDir` | `string` | No | キャッシュディレクトリ（default: `<repoRoot>/cache`） |
| `profile` | `Record<string, string>` | No | ビルドプロファイル |

### UpdateResult

| フィールド | 型 | 説明 |
|---|---|---|
| `ok` | `boolean` | エラーなしで完了したか |
| `facts` | `Facts` | 更新後の facts |
| `affectedUnits` | `string[]` | 影響を受けた unit ID リスト |
| `fallbackToIndex` | `boolean` | フル再構築にフォールバックしたか |
| `errors` | `string[]` | 致命的エラー |
| `warnings` | `string[]` | 警告 |

## 依存

- `core/fingerprint`: fingerprint 比較
- `core/schema`: facts スキーマ定義
- `core/storage`: JSON 読み書き
- `core/diff`: 影響 unit の特定（`impactUnits`）、facts のマージ（`applyDelta`）
- `skills/index`: フォールバック時のフルインデックス
- `skills/registry`: アダプタ登録
- `adapters/<lang>`: 各言語アダプタ（indexUnits, diagnose）

## 実装

### 配置先

- スキル実装: `skills/update.ts`
- テスト: `skills/update.test.ts`

### 処理フロー

1. **Fingerprint チェック**
   - 現在環境の fingerprint を生成
   - `cache/fingerprint.json` と比較
   - 不一致の場合は `indexFacts()` にフォールバック

2. **既存 Facts の読み込み**
   - `readFacts()` で `cache/facts.json` を読み込む
   - 不在の場合は `indexFacts()` にフォールバック

3. **影響 Unit の特定**
   - `impactUnits(changedFiles, facts)` で影響を受ける unit を特定
   - 影響なしの場合は既存 facts をそのまま返却

4. **影響 Unit の再解析**
   - 古いデータの removal delta を構築（affected units を削除）
   - `applyDelta()` で古いデータを除去
   - 影響 unit のみを `indexUnits()` で再解析
   - 新しい FactsDelta を `applyDelta()` でマージ

5. **Diagnostics 再取得**
   - 影響 unit の diagnostics を `diagnose()` で再取得

6. **保存**
   - `writeFacts()` で更新された facts を保存

### エラーハンドリング

- Fingerprint 不一致: `indexFacts()` にフォールバック（自動）
- `cache/facts.json` 不在: `indexFacts()` にフォールバック
- 一部 unit の解析失敗: errors に記録し、他は継続

## 使用例

```typescript
import { updateFacts } from "./skills/update.ts";

// Git diff から変更ファイルを取得して差分更新
const result = await updateFacts({
  repoRoot: "/path/to/repo",
  changedFiles: ["internal/service/user.go"],
});

if (result.fallbackToIndex) {
  console.log("Fell back to full index");
} else {
  console.log(`Affected units: ${result.affectedUnits.join(", ")}`);
}
```

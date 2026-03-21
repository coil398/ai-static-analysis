# TypeScript アダプタ仕様 (TS_SPEC.md)

本書は TypeScript/JavaScript 言語アダプタ固有の仕様を定義する。共通インターフェースは SPEC.md §8 を参照。

---

## 1. 使用ツール

| ツール | 用途 | 必須 |
|---|---|---|
| `node` | ランタイム | MUST |
| `tsc` | 型チェック | SHOULD |
| `eslint` | リンティング | MAY |
| `prettier` / `biome` | フォーマット | MAY |
| `vitest` / `jest` | テスト | MAY |

`doctor()` で `node` の存在を確認する。`node` が無い場合は `ok: false`。

---

## 2. Unit マッピング

TypeScript の解析単位は **project**（`tsconfig.json` 単位）。

```
Unit {
  id:   "unit:ts:<relative_path>"     // e.g. "unit:ts:packages/core"
  kind: "ts_project"
  name: "<directory_name>"
  path: "<relative_path>"
  metadata: {
    tsconfig: "<relative_tsconfig_path>"
    repo_root: "<absolute_path>"
  }
}
```

---

## 3. ID 規約

- Unit: `unit:ts:<relative_dir>`
- File: `file:<relative_path>` (e.g. `file:src/index.ts`)
- Symbol: `sym:ts:<unit_path>#<kind>#<name>#sig:<hash>`

---

## 4. 依存解決

- ファイル内の `import`/`require`/動的 `import()` を正規表現で解析
- 相対パス import のみ内部依存として抽出（`node_modules` は対象外）
- import 先ファイルのディレクトリから所属 unit を逆引き

---

## 5. 生成ファイル検出

先頭 1KB に以下のマーカーがあれば生成ファイル:
- `// Code generated`
- `// auto-generated`
- `@generated`

---

## 6. Diagnostics

| ツール | 出力形式 | severity マッピング |
|---|---|---|
| `tsc --noEmit` | `file(line,col): error TSxxxx: msg` | error/warning |
| `eslint --format json` | JSON array | severity 2→error, 1→warning |

循環依存検出は deps グラフの DFS で実装（外部ツール不要）。

---

## 7. ActionAdapter

| アクション | コマンド |
|---|---|
| format | `prettier --write` or `biome format --write` |
| check | `tsc --noEmit` + `eslint` |
| test | `vitest run` or `jest` or `npm test` |

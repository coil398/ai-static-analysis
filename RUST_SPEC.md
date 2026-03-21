# Rust アダプタ仕様 (RUST_SPEC.md)

本書は Rust 言語アダプタ固有の仕様を定義する。共通インターフェースは SPEC.md §8 を参照。

---

## 1. 使用ツール

| ツール | 用途 | 必須 |
|---|---|---|
| `rustc` | コンパイラ | MUST |
| `cargo` | ビルドツール | MUST |
| `clippy` | リンティング (`cargo clippy`) | SHOULD |
| `rustfmt` | フォーマット (`cargo fmt`) | SHOULD |
| `rust-analyzer` | symbols/refs/type_relations | MAY |
| `cargo-audit` | 依存脆弱性スキャン | MAY |

`doctor()` で `rustc` と `cargo` の存在を確認する。どちらかが無い場合は `ok: false`。

---

## 2. Unit マッピング

Rust の解析単位は **crate**（`Cargo.toml` 単位）。ワークスペースメンバーのみ対象。

```
Unit {
  id:   "unit:rs:<relative_path>"     // e.g. "unit:rs:crates/core"
  kind: "rust_crate"
  name: "<crate_name>"
  path: "<relative_path>"
  metadata: {
    cargo_id: "<cargo_package_id>"
    manifest_path: "<relative_Cargo.toml_path>"
    repo_root: "<absolute_path>"
  }
}
```

---

## 3. ID 規約

- Unit: `unit:rs:<relative_dir>`
- File: `file:<relative_path>` (e.g. `file:crates/core/src/lib.rs`)
- Symbol: `sym:rs:<unit_path>#<kind>#<name>#sig:<hash>`

---

## 4. 依存解決

- `cargo metadata --no-deps` でワークスペース内パッケージと依存を取得
- ワークスペースメンバー間の依存のみ抽出
- `dev-dependencies` は `kind: "dev_dependency"` として区別

---

## 5. 生成ファイル検出

先頭 1KB に以下のマーカーがあれば生成ファイル:
- `// Code generated`
- `// auto-generated`
- `@generated`

`target/` ディレクトリは走査対象外。

---

## 6. Diagnostics

| ツール | 出力形式 | severity マッピング |
|---|---|---|
| `cargo clippy --message-format=json` | JSON lines (compiler messages) | error/warning/note→info |
| `cargo check --message-format=json` | 同上（clippy 未使用時のフォールバック） | 同上 |
| `cargo audit --json` | JSON `{vulnerabilities:{list:[...]}}` | 全て error |

循環依存検出は deps グラフの DFS で実装（外部ツール不要）。

---

## 7. ActionAdapter

| アクション | コマンド |
|---|---|
| format | `cargo fmt --all` |
| check | `cargo clippy -- -D warnings` |
| test | `cargo test` |

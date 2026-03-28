# Python アダプタ仕様 (PYTHON_SPEC.md)

本書は Python 言語アダプタ固有の仕様を定義する。共通インターフェースは SPEC.md §8 を参照。

---

## 1. 使用ツール

| ツール | 用途 | 必須 |
|---|---|---|
| `python` / `python3` | ランタイム | MUST |
| `pyright-langserver` / `basedpyright-langserver` | symbols/refs/call_edges (LSP) | SHOULD |
| `ruff` | リンティング・フォーマット | SHOULD |
| `mypy` | 型チェック（diagnostics） | MAY |
| `bandit` | セキュリティ分析 | MAY |
| `pytest` | テスト | MAY |

`doctor()` で `python` の存在を確認する。`python` が無い場合は `ok: false`。
`pyright-langserver` 未インストール時は symbols/refs/call_edges が空配列にフォールバック。

### type_relations の取得方法

Pyright は `textDocument/implementation` および `textDocument/prepareTypeHierarchy` を未サポートのため、type_relations はソース解析で取得する。`class Foo(Bar, Baz):` パターンをパースし、既知シンボル間の継承関係を `implements` として出力する。複数行の基底クラスリスト、`metaclass=` 引数、`Generic[T]` などのジェネリクス指定はフィルタする。

---

## 2. Unit マッピング

Python の解析単位は **package**（`__init__.py` を含むディレクトリ）。
パッケージが見つからない場合は `pyproject.toml` / ルートを単一 unit として扱う。

```
Unit {
  id:   "unit:py:<relative_path>"     // e.g. "unit:py:mypackage"
  kind: "py_package" | "py_project"
  name: "<package_name>"
  path: "<relative_path>"
  metadata: {
    repo_root: "<absolute_path>"
  }
}
```

---

## 3. ID 規約

- Unit: `unit:py:<relative_dir>`
- File: `file:<relative_path>` (e.g. `file:mypackage/core.py`)
- Symbol: `sym:py:<unit_path>#<kind>#<name>#sig:<hash>`

---

## 4. 依存解決

- `import X` / `from X import Y` を正規表現で解析
- モジュール名のトップレベルを unit 名として照合
- ドット区切りパスを `/` に変換して unit を逆引き

---

## 5. 生成ファイル検出

先頭 1KB に以下のマーカーがあれば生成ファイル:
- `# Code generated`
- `# Automatically generated`
- `@generated`

---

## 6. Diagnostics

| ツール | 出力形式 | severity マッピング |
|---|---|---|
| `ruff check --output-format json` | JSON array | fix 可→warning, 不可→error |
| `mypy` | `file:line: level: msg` | error/warning/note→info |
| `bandit -f json` | JSON `{results:[...]}` | HIGH→error, MEDIUM→warning, LOW→info |

循環依存検出は deps グラフの DFS で実装（外部ツール不要）。

---

## 7. ActionAdapter

| アクション | コマンド |
|---|---|
| format | `ruff format` or `black` |
| check | `ruff check` + `mypy` |
| test | `pytest` or `python -m unittest discover` |

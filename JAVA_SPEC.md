# Java アダプタ仕様 (JAVA_SPEC.md)

本書は Java 言語アダプタ固有の仕様を定義する。共通インターフェースは SPEC.md §8 を参照。

---

## 1. 使用ツール

| ツール | 用途 | 必須 |
|---|---|---|
| `javac` / `java` (JDK 17+) | ランタイム | MUST |
| `mvn` | Maven ビルド・テスト | MAY |
| `gradle` | Gradle ビルド・テスト | MAY |
| `jdtls` (Eclipse JDT LSP) | symbols/refs/call_edges（将来の拡張） | MAY |
| `checkstyle` | スタイルチェック（diagnostics） | MAY |
| `spotbugs` | バグパターン検出 | MAY |
| `pmd` | 静的解析 | MAY |
| `google-java-format` | フォーマッタ | MAY |

`doctor()` は `javac` の有無のみ MUST。LSP・ビルドツール・linter は未インストール時に該当機能を degrade。

### 現状の制約

現バージョンの Java アダプタはパーサベースで `symbols` を抽出する（トップレベルの `class` / `interface` / `enum` / `record` のみ）。`refs` / `call_edges` / `type_relations` は LSP 統合前のため**空配列**になる。jdtls との接続は将来追加予定（同じ `adapters/shared/lsp-client.ts` の `LspClient` を流用できる）。

---

## 2. Unit マッピング

Java の解析単位は **モジュール / サブプロジェクト**。

| ビルド形式 | 検出ロジック |
|---|---|
| Maven multi-module | ルート `pom.xml` の `<modules><module>...</module></modules>` を列挙 |
| Maven single-module | ルートを単一 unit (`unit:java:.`) |
| Gradle multi-project | `settings.gradle(.kts)` の `include 'foo'` / `include(":foo:bar")` を解析 |
| Gradle single-project | ルートを単一 unit (`unit:java:.`) |
| ビルドスクリプト無し | `.java` ファイルが直下にあればルートを単一 unit |

```
Unit {
  id:   "unit:java:<relative_path>"  // e.g. "unit:java:app"
  kind: "java_module"
  name: "<module_name>"
  path: "<relative_path>"
  metadata: {
    repo_root: "<absolute_path>"
    package_prefixes: ["com.example.app", ...]  // src/main/java から導出
  }
}
```

---

## 3. ID 規約

- Unit: `unit:java:<relative_dir>`（ルート単一の場合 `unit:java:.`）
- File: `file:<relative_path>`（例: `file:app/src/main/java/com/example/app/Main.java`）
- Symbol: `sym:java:<unit_path>#<kind>#<name>#sig:<hash>` — 現状 `kind` は `class` / `interface` / `enum` / `record` のみ

---

## 4. 依存解決

- `.java` ファイルの先頭近辺の `import [static] FQN[.*];` を正規表現で抽出
- 末尾が `.*` の場合はそのままパッケージ、それ以外は最後の識別子を 1 つ削って パッケージ FQN とする
- 各 unit の `metadata.package_prefixes` と prefix マッチで unit_id に解決
- 同一 unit 内の import は `deps` に含めない

---

## 5. シンボル抽出

正規表現で「行頭の修飾子列 + `class|interface|enum|record` + 名前」を拾う。

- `private` / `protected` を含む宣言は `exported: false`
- それ以外（`public` 含む、無修飾の package-private 含む）は `exported: true`
- 位置情報は宣言キーワードの 1-based (line, column)

メソッド・フィールド・ローカル宣言は LSP 統合まで扱わない。

---

## 6. Diagnostics

| ツール | 検出内容 | 条件 |
|---|---|---|
| `detectCyclicDeps` (内蔵) | unit 間の循環依存 | 常時 |
| `checkstyle` | スタイル違反 | `checkstyle` が PATH にあり、かつ `checkstyle.xml` または `config/checkstyle/checkstyle.xml` が存在 |
| （将来）spotbugs / pmd | バグパターン / 静的解析 | 同等条件で追加予定 |

checkstyle の出力は XML（`-f xml`）を期待。`<file name="...">` 配下の `<error line column severity message />` を Diagnostic に変換する。

---

## 7. Bootstrap

Java ツールチェインは OS による差異が大きいため、`bootstrap()` は自動インストールを試みず、推奨コマンドを `notes` に記載する。利用者が手動でインストールする想定:

- JDK: 各 OS のパッケージマネージャ or sdkman
- jdtls: GitHub Releases（`https://github.com/eclipse-jdtls/eclipse.jdt.ls`）からダウンロードし PATH へ
- Maven / Gradle: `brew` / `apt` / Chocolatey

---

## 8. Actions

| action | 優先順 |
|---|---|
| `format` | `google-java-format` → Gradle `spotlessApply` → Maven `spotless:apply` |
| `check` | Gradle `check` または Maven `verify` |
| `test` | Gradle `test` または Maven `test` |

`scope` に応じたターゲット指定はビルドツール側の機能（`-pl module` 等）に委ね、本アダプタはトップレベルのコマンドのみ発行する。

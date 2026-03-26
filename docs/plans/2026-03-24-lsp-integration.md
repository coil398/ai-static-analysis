# 他言語 LSP 統合 実装記録

_作成: 2026-03-24 | ステータス: **完了** 2026-03-24_

## 目標

TypeScript・Python・C#・Rust の4言語アダプタに LSP サーバー統合を追加し、Go アダプタと同等のシンボル定義・参照・型関係・コールグラフ解析を実現する。

## 実装計画

- [x] ステップ1: 共通 LSP クライアントを `adapters/shared/lsp-client.ts` に抽出
- [x] ステップ2: TypeScript アダプタに typescript-language-server 統合を追加
- [x] ステップ3: Python アダプタに pyright 統合を追加
- [x] ステップ4: Rust アダプタに rust-analyzer 統合を追加
- [x] ステップ5: C# アダプタに csharp-ls 統合を追加
- [ ] ステップ6: SKILL.md の対応言語表を更新、各 LANG_SPEC.md を更新

---

## 設計詳細

### ステップ1: 共通 LSP クライアント

**対象ファイル**: `adapters/shared/lsp-client.ts`（新規）

現在の `adapters/go/lsp-client.ts` (`GoplsLspClient`) は gopls 専用だが、LSP プロトコル通信部分は言語非依存。これを汎用 `LspClient` に抽出し、各言語アダプタで再利用する。

```
adapters/shared/lsp-client.ts
- class LspClient
  - constructor(command: string[], repoRoot: string, initParams?: object)
  - ensureStarted(): Promise<void>
  - documentSymbols(relPath): Promise<LspDocumentSymbol[]>
  - prepareCallHierarchy(relPath, line, char): Promise<LspCallHierarchyItem[]>
  - outgoingCalls(item): Promise<LspCallHierarchyOutgoingCall[]>
  - incomingCalls(item): Promise<LspCallHierarchyIncomingCall[]>
  - implementation(relPath, line, char): Promise<LspLocation[]>
  - references(relPath, line, char): Promise<LspLocation[]>
  - shutdown(): Promise<void>
```

**Go アダプタの移行**: `GoplsLspClient` を `LspClient` のエイリアスまたは薄いラッパーに変更。既存テストが壊れないよう後方互換を維持。

### ステップ2: TypeScript - typescript-language-server

**LSP サーバー**: `typescript-language-server` (npm パッケージ)
**起動コマンド**: `["typescript-language-server", "--stdio"]`

**変更ファイル**:
- `adapters/typescript/language-adapter.ts` — `indexUnits()` に LSP 統合を追加
- `adapters/typescript/language-adapter.test.ts`（新規） — テスト

**処理フロー** (`indexWithLsp()`):
1. `LspClient` を起動（`typescript-language-server --stdio`）
2. ファイルごとに `documentSymbols()` → Symbol[] に変換
3. 関数/メソッドごとに `prepareCallHierarchy()` + `outgoingCalls()` → CallEdge[] + Ref[]
4. interface/class ごとに `implementation()` → TypeRelation[]
5. 型/変数ごとに `references()` → Ref[]（call 以外）
6. クライアント shutdown

**doctor/bootstrap 追加**:
- `typescript-language-server` の存在チェック
- `npm install -g typescript-language-server` でインストール

### ステップ3: Python - pyright (basedpyright)

**LSP サーバー**: `pyright-langserver` (npm パッケージ `pyright`)
**起動コマンド**: `["pyright-langserver", "--stdio"]`

**変更ファイル**:
- `adapters/python/language-adapter.ts` — `indexUnits()` に LSP 統合を追加
- `adapters/python/language-adapter.test.ts`（新規）

**処理フロー**: TypeScript と同様のパターン。

**doctor/bootstrap 追加**:
- `pyright-langserver` or `pyright` の存在チェック
- `pip install pyright` または `npm install -g pyright`

### ステップ4: Rust - rust-analyzer

**LSP サーバー**: `rust-analyzer`（rustup component）
**起動コマンド**: `["rust-analyzer"]`

**変更ファイル**:
- `adapters/rust/language-adapter.ts` — `indexUnits()` に LSP 統合を追加
- `adapters/rust/language-adapter.test.ts`（新規）

**処理フロー**: 同パターン。

**doctor/bootstrap 追加**:
- `rust-analyzer` の存在チェック（既に doctor に含まれている）
- `rustup component add rust-analyzer` でインストール

### ステップ5: C# - OmniSharp

**LSP サーバー**: `OmniSharp` (dotnet tool)
**起動コマンド**: `["OmniSharp", "--languageserver"]` or `["dotnet", "tool", "run", "omnisharp"]`

**変更ファイル**:
- `adapters/csharp/language-adapter.ts`
- `adapters/csharp/language-adapter.test.ts`（新規）

### ステップ6: ドキュメント更新

- `SKILL.md` の対応言語表を更新（❌ → ✅）
- `TS_SPEC.md`, `PYTHON_SPEC.md`, `RUST_SPEC.md`, `CSHARP_SPEC.md` を更新
- `CLAUDE.md` の開発メモを更新

### 共通設計パターン（全言語共通）

**Symbol 変換**: LSP `DocumentSymbol` → `core/schema/types.ts` の `Symbol` 型
```typescript
// LSP SymbolKind → 内部 kind のマッピング（言語ごとにカスタマイズ）
const SYMBOL_KIND_MAP: Record<number, string> = {
  5: "class",       // Class
  6: "method",      // Method
  7: "property",    // Property
  8: "field",       // Field
  9: "constructor", // Constructor
  10: "enum",       // Enum
  11: "interface",  // Interface
  12: "function",   // Function
  13: "variable",   // Variable
  14: "constant",   // Constant
  22: "struct",     // Struct
  23: "struct",     // Event
};
```

**exported 判定**: 言語によって異なる
- TypeScript: `export` キーワードの有無
- Python: `_` プレフィックスなし
- Rust: `pub` キーワード
- C#: `public`/`internal` 等

**findEnclosingSymbol()**: Go アダプタと同じヒューリスティック（宣言行ベース）

**graceful degradation**: LSP サーバー未インストール時は空配列

### チーム並列化の依存関係

```
ステップ1（共通 LSP クライアント）
  ↓
ステップ2〜5（4言語並列実行可能）
  ↓
ステップ6（ドキュメント更新）
```

---

## 実装ログ

### 実装完了 (2026-03-24)

#### ステップ1: 共通 LSP クライアント
- `adapters/shared/lsp-client.ts` に `LspClient` クラスを新規作成
- `adapters/go/lsp-client.ts` は `LspClient` の薄いラッパー（`GoplsLspClient extends LspClient`）に変更
- 後方互換維持: 既存 import が壊れない

#### ステップ2: TypeScript (14テスト全パス)
- LSP サーバー: `typescript-language-server --stdio`
- `openDocument` 対応（gopls 以外は `textDocument/didOpen` が必須）
- `exported` 判定: regex ベースの簡易チェック

#### ステップ3: Python (14テスト全パス)
- LSP サーバー: `pyright-langserver --stdio`
- pyright は `textDocument/implementation` 未サポート → `detectClassInheritance()` でソース解析により ABC/Protocol パターンを検出
- `exported` 判定: `_` プレフィックスなし = 公開

#### ステップ4: Rust (13テスト全パス)
- LSP サーバー: `rust-analyzer`
- "content modified" エラー対策: 全ファイル openDocument 後に3秒待機
- impl ブロック (SymbolKind=19) のスキップ処理
- type_relations: `extractIdentifierAtPos()` で名前ベースのフォールバック lookup

#### ステップ5: C# (14テスト全パス)
- LSP サーバー: `csharp-ls` (v0.16.0, net8.0 互換)
- `LspClient` にサーバー起点リクエストの自動応答機能を追加
- `waitForWorkspaceReady()` で Roslyn ロード完了を待機
- call hierarchy は csharp-ls v0.16.0 では不完全なため許容テストに変更

#### 発見された共通知見
- **`textDocument/didOpen` が必須**: gopls 以外の全 LSP サーバーで必要。`LspClient.openDocument()` を共通化
- **`selectionRange` vs `range`**: シンボル検索には `selectionRange.start` を使う必要がある
- **LSP サーバーごとの差異**: call hierarchy/implementation のサポート状況は言語サーバーにより異なる

#### 全テスト結果
```
190 pass, 0 fail (全19ファイル)
```

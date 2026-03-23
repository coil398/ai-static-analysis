## 静的解析（ai-static-analysis）

本プロジェクトには静的解析基盤が導入されている。コード変更時は以下のワークフローに従うこと。

### ツール配置

- 解析ツール: `.claude/tools/static-analysis/`
- スキル定義: `.claude/tools/static-analysis/*.md`（ルート直下の .md ファイル）
- キャッシュ: `cache/`（Git 管理外、安全に削除可能）

### 推奨ワークフロー

#### セッション開始時

1. `cache/fingerprint.json` が存在しない、または古い場合 → `index-facts` を実行
2. facts が最新なら → そのまま作業開始

#### コード変更時

1. 変更前に `query-facts` で影響範囲を確認（`impact` クエリ）
2. 変更を実施
3. `update-facts` で差分更新
4. `run-actions check` で検証

#### コードレビュー・調査時

- 依存関係の把握: `query-facts deps <unit>`
- 逆依存の把握: `query-facts rdeps <unit>`
- シンボル定義の検索: `query-facts defs <name>`
- 参照の検索: `query-facts refs <symbol>`
- デッドコード検出: `query-facts dead-code`
- 診断の確認: `query-facts diagnostics`

#### 品質分析（オプション）

- `analyze-insights` で AI 分析を実行（バグ臭・設計パターン・命名・重複）
- `query-insights` で分析結果を参照

### スキル実行方法

各スキルは `.claude/tools/static-analysis/` 内のスキル定義（.md）と TypeScript API で実装されている。

```typescript
import { indexFacts } from "./.claude/tools/static-analysis/skills/index.ts";
import { queryDeps } from "./.claude/tools/static-analysis/skills/query.ts";
```

### 注意事項

- facts は決定論ツール（LSP/コンパイラ/静的解析器）の出力であり、AI の推測ではない
- fingerprint が変わったら cache を wipe してフルリビルドが必要
- 解析ツールが未インストールの場合は `bootstrap-tools` で自動導入可能

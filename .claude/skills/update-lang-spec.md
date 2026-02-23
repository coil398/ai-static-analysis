# update-lang-spec — 言語別仕様の更新

## トリガー

言語アダプタの実装追加・変更時に実行する。

## やること

1. 対応する `<LANG>_SPEC.md`（ルート直下）を実装内容に合わせて更新する
   - 新規言語の場合は新しい `<LANG>_SPEC.md` を作成する
2. `SPEC.md` §8.4 の言語別仕様一覧を更新する

## チェックリスト

`<LANG>_SPEC.md` に以下が記載されていることを確認:

- [ ] 使用ツール一覧（MUST/SHOULD の区別）
- [ ] Unit マッピング（kind, ID フォーマット）
- [ ] ID 規約（unit, file, symbol）
- [ ] 依存解決方針（何をスキップするか）
- [ ] Generated file の判定方法
- [ ] Diagnostics のパース仕様
- [ ] ActionAdapter のコマンド定義
- [ ] Fingerprint の build_profile キー
- [ ] MVP スコープと degrade 方針
- [ ] テスト方針

## 命名規約

- ファイル名: `<LANG>_SPEC.md`（大文字、例: `GO_SPEC.md`, `TS_SPEC.md`, `PY_SPEC.md`）
- SPEC.md §8.4 のエントリ形式: `- \`<LANG>_SPEC.md\` — <Lang> アダプタ仕様`

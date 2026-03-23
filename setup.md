# setup

対象プロジェクトに ai-static-analysis を導入し、CLAUDE.md とフック設定を行う。

---

## 概要

このスキルは対象プロジェクトに静的解析基盤を導入するためのセットアップを行う。
以下を自動設定する:

1. CLAUDE.md に静的解析の使い方セクションを追加
2. SessionStart フックを settings.json に設定
3. `.gitignore` に `cache/` を追加
4. 初回の `bootstrap-tools` + `index-facts` を実行

## 前提条件

- このリポジトリが対象プロジェクトの `.claude/tools/static-analysis/` にクローン済み
- Bun がインストール済み

## 手順

### Step 1: クローン

```bash
cd <対象プロジェクト>
mkdir -p .claude/tools
git clone <ai-static-analysis-repo-url> .claude/tools/static-analysis
```

### Step 2: CLAUDE.md にスニペットを追加

`templates/claude-snippet.md` の内容を対象プロジェクトの `CLAUDE.md` に追記する。

既に `CLAUDE.md` がある場合はファイル末尾に追記。なければ新規作成。

```bash
cat .claude/tools/static-analysis/templates/claude-snippet.md >> CLAUDE.md
```

### Step 3: SessionStart フックを設定

対象プロジェクトの `.claude/settings.json` に以下のフック設定を追加する。

`settings.json` が存在しない場合は新規作成。存在する場合は `hooks` セクションにマージ。

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "bash .claude/tools/static-analysis/scripts/session-check.sh ."
      }
    ]
  }
}
```

### Step 4: .gitignore に cache/ を追加

```bash
echo "cache/" >> .gitignore
```

（既に含まれている場合はスキップ）

### Step 5: 初回セットアップ

```bash
# 解析ツールのインストール
# bootstrap-tools を実行

# コードベースのフルインデックス
# index-facts を実行（repoRoot: .）
```

## セットアップ後の動作

### Claude Code 起動時

SessionStart フックが実行され、以下のいずれかが表示される:

- `[static-analysis] facts が未生成です。index-facts を実行してコードベースを解析してください。`
- `[static-analysis] facts は 3 日前に生成。変更があれば update-facts で更新できます。`
- `[static-analysis] facts 生成後に 12 ファイルが変更されています。update-facts で差分更新できます。`
- `[static-analysis] facts は最新です。query-facts でクエリ可能です。`

### 通常のワークフロー

CLAUDE.md に記載された推奨ワークフローに従う。セッション開始時にフックのメッセージを確認し、必要に応じて facts を更新する。

## 配置のバリエーション

### git submodule として導入

```bash
git submodule add <repo-url> .claude/tools/static-analysis
```

### 別の場所にクローンしてシンボリックリンク

```bash
git clone <repo-url> ~/tools/static-analysis
ln -s ~/tools/static-analysis .claude/tools/static-analysis
```

いずれの場合も `.claude/tools/static-analysis/` にこのリポジトリが見えていれば動作する。

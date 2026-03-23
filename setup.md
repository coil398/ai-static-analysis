# setup

対象プロジェクトに ai-static-analysis を導入し、SessionStart フックを設定する。

---

## 概要

このスキルは対象プロジェクトに静的解析基盤を導入するためのセットアップを行う。
以下を設定する:

1. SessionStart フックを settings.json に設定
2. `.gitignore` に `cache/` を追加
3. 初回の `bootstrap-tools` + `index-facts` を実行

## 前提条件

- このリポジトリが対象プロジェクトの `.claude/skills/ai-static-analysis/` にクローン済み
- Bun がインストール済み

## 手順

### Step 1: クローン

```bash
cd <対象プロジェクト>
git clone <ai-static-analysis-repo-url> .claude/skills/ai-static-analysis
```

Claude Code は `.claude/skills/ai-static-analysis/SKILL.md` を自動検出し、このスキルを認識する。

### Step 2: SessionStart フックを設定

対象プロジェクトの `.claude/settings.json` に以下のフック設定を追加する。

`settings.json` が存在しない場合は新規作成。存在する場合は `hooks` セクションにマージ。

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "bash .claude/skills/ai-static-analysis/scripts/session-check.sh ."
      }
    ]
  }
}
```

### Step 3: .gitignore に cache/ を追加

```bash
echo "cache/" >> .gitignore
```

（既に含まれている場合はスキップ）

### Step 4: 初回セットアップ

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

SKILL.md に記載されたワークフローに従う。セッション開始時にフックのメッセージを確認し、必要に応じて facts を更新する。

## 配置のバリエーション

### git submodule として導入

```bash
git submodule add <repo-url> .claude/skills/ai-static-analysis
```

### 別の場所にクローンしてシンボリックリンク

```bash
git clone <repo-url> ~/tools/static-analysis
ln -s ~/tools/static-analysis .claude/skills/ai-static-analysis
```

いずれの場合も `.claude/skills/ai-static-analysis/` にこのリポジトリが見えていれば動作する。

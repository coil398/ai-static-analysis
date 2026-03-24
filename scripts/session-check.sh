#!/usr/bin/env bash
# SessionStart hook: facts の鮮度をチェックして案内を出力する
# 配置先: 対象プロジェクトの .claude/hooks/ や settings.json から参照

set -euo pipefail

REPO_ROOT="${1:-.}"
TOOLS_DIR="${REPO_ROOT}/.claude/skills/ai-static-analysis"
CACHE_DIR="${REPO_ROOT}/cache"
FINGERPRINT="${CACHE_DIR}/fingerprint.json"
FACTS_DIR="${CACHE_DIR}/facts"

# ツール配置チェック
if [ ! -d "$TOOLS_DIR" ]; then
  echo "[static-analysis] 未セットアップです。セットアップするには:"
  echo "  git clone <ai-static-analysis-repo> ${TOOLS_DIR}"
  echo "  その後 setup スキルを実行してください"
  exit 0
fi

# facts 存在チェック（JSONL 形式: cache/facts/ ディレクトリ）
if [ ! -d "$FACTS_DIR" ]; then
  echo "[static-analysis] facts が未生成です。index-facts を実行してコードベースを解析してください。"
  exit 0
fi

# fingerprint 鮮度チェック
if [ ! -f "$FINGERPRINT" ]; then
  echo "[static-analysis] fingerprint が見つかりません。index-facts でフルリビルドを推奨します。"
  exit 0
fi

# fingerprint の日付を確認（ファイル更新日）
if command -v stat >/dev/null 2>&1; then
  fp_age_days=0
  if [ "$(uname)" = "Darwin" ]; then
    fp_mtime=$(stat -f %m "$FINGERPRINT")
  else
    fp_mtime=$(stat -c %Y "$FINGERPRINT")
  fi
  now=$(date +%s)
  fp_age_days=$(( (now - fp_mtime) / 86400 ))

  if [ "$fp_age_days" -ge 7 ]; then
    echo "[static-analysis] facts が ${fp_age_days} 日前のものです。update-facts で差分更新するか、index-facts でフルリビルドを推奨します。"
    exit 0
  elif [ "$fp_age_days" -ge 1 ]; then
    echo "[static-analysis] facts は ${fp_age_days} 日前に生成。変更があれば update-facts で更新できます。"
    exit 0
  fi
fi

# git diff で変更ファイル数を確認
if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  # fingerprint に記録された commit と現在の HEAD を比較
  # Bun（必須ランタイム）で JSON パース。jq 不要。
  fp_commit=""
  if command -v bun >/dev/null 2>&1; then
    fp_commit=$(bun -e "try{const f=JSON.parse(require('fs').readFileSync('$FINGERPRINT','utf8'));console.log(f.repo_state?.commit_hash??f.repo_state?.commit??'')}catch{}" 2>/dev/null)
  else
    # bun がない場合は grep ベースのフォールバック（正確性は劣る）
    fp_commit=$(grep -o '"commit_hash"[[:space:]]*:[[:space:]]*"[^"]*"' "$FINGERPRINT" 2>/dev/null | head -1 | sed 's/.*"commit_hash"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    if [ -z "$fp_commit" ]; then
      fp_commit=$(grep -o '"commit"[[:space:]]*:[[:space:]]*"[^"]*"' "$FINGERPRINT" 2>/dev/null | head -1 | sed 's/.*"commit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    fi
  fi
  if [ -n "$fp_commit" ]; then
    changed_count=$(git -C "$REPO_ROOT" diff --name-only "$fp_commit" HEAD 2>/dev/null | wc -l | tr -d ' ')
    if [ "$changed_count" -gt 0 ]; then
      echo "[static-analysis] facts 生成後に ${changed_count} ファイルが変更されています。update-facts で差分更新できます。"
      exit 0
    fi
  fi
fi

echo "[static-analysis] facts は最新です。query-facts でクエリ可能です。"

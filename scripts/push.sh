#!/usr/bin/env bash
# 在能上网的机器上把本仓库推到 GitHub。需要一把有 repo 权限的 PAT。
# 用法：./scripts/push.sh <用户名> <token> <仓库名>
set -euo pipefail

USER_NAME="${1:?用法: push.sh <用户名> <token> <仓库名>}"
TOKEN="${2:?缺少 token}"
REPO="${3:-dsh-fish-mood}"

cd "$(dirname "$0")/.."

if [ ! -d .git ]; then
  git init -q
  git checkout -q -b main 2>/dev/null || true
fi

git add -A
git -c user.name="$USER_NAME" -c user.email="$USER_NAME@users.noreply.github.com" \
  commit -q -m "feat: 七维心情状态机 + 本地面板（管理员模式）" || echo "没有新改动"

git remote remove origin 2>/dev/null || true
git remote add origin "https://${USER_NAME}:${TOKEN}@github.com/${USER_NAME}/${REPO}.git"
git push -u origin main

# 推完把 token 从 remote 里清掉，别留在 .git/config
git remote set-url origin "https://github.com/${USER_NAME}/${REPO}.git"
echo "✅ 已推送；token 已从 remote 移除"

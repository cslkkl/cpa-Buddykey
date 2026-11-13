#!/usr/bin/env bash
#
# 起 BuddyKey（Linux / macOS）。
#
# 与 start.cmd 等价，只是平台不同。服务器上一般不用它 —— 用 systemd 更好，
# 见 docs/DEPLOY-SERVER.md。这个脚本是给「手动跑一下看看」用的。
#
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node。装一个 Node >= 20（https://nodejs.org 或用 nvm）。" >&2
  exit 1
fi

MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 20 ]; then
  echo "Node 版本太低（$(node -v)），需要 >= 20。" >&2
  exit 1
fi

exec node server.mjs

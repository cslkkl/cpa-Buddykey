#!/usr/bin/env bash
#
# 一键在服务器上装好 BuddyKey 全套。
# 在华为云「远程登录」的黑框里粘一段跑完即可 —— 见下面的用法。
#
# 设计取舍：
#   - **非交互**：所有问题用默认值回答，装完把口令和地址打印出来。
#     远程终端里没人陪着一问一答，少一次输入就少一次出错机会。
#   - **绑定 0.0.0.0 + 随机口令**：服务器就是要给外面连的。口令是必须的，
#     否则 /admin/api/* 谁都能建 key 白嫖（服务端会拒绝在非本机地址上无口令启动）。
#   - **systemd 常驻**：这样重启机器也会自己起来，才真正是「不依赖电脑」。
#
set -euo pipefail

REPO_URL="https://github.com/cslkkl/cpa-Buddykey.git"
DIR="/opt/buddykey"
CPA_PORT=8317
APP_PORT=8318

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

# 远程登录有时直接是 root，有时是普通用户。统一算一个前缀，别假设。
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

step "1/6 装 Node 与 git"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq curl ca-certificates git
  # ⚠️ 不能写成 curl … | $SUDO -E bash -：SUDO 为空时那会变成 `| -E bash -`，
  #   bash 找不到叫 -E 的命令，直接失败。先落盘再执行，两种身份都成立。
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesetup.sh
  $SUDO bash /tmp/nodesetup.sh
  rm -f /tmp/nodesetup.sh
  $SUDO apt-get install -y -qq nodejs
fi
echo "node $(node -v) / git $(git --version | awk '{print $3}')"

step "2/6 取代码"
if [ -d "$DIR/.git" ]; then
  cd "$DIR"
  git pull --ff-only || echo "（拉不到新版本，就用本地这份）"
else
  $SUDO mkdir -p "$(dirname "$DIR")"
  $SUDO git clone --depth 1 "$REPO_URL" "$DIR"
  cd "$DIR"
fi
cd "$DIR"
# ⚠️ chown 放在 if 外面：如果别人先 sudo git clone 过这份代码，
#   目录归 root，后面 node 写 data/ 会 permission denied。
#   每次部署都纠正一次，代价是一次递归 chown，比排查权限问题便宜。
if [ "$(id -u)" -ne 0 ]; then
  $SUDO chown -R "$(id -u):$(id -g)" "$DIR"
fi
echo "代码在 $DIR（$(git rev-parse --short HEAD)）"

step "3/6 装上游（CPA 本体 + workbuddy 插件，约 30 MB，等 1-2 分钟）"
if [ -f runtime/cpa/config.yaml ]; then
  echo "已经装过了，跳过"
else
  # --oauth-region cn：登录走 copilot.tencent.com（国内区）。
  # 不传的话插件默认 intl，登录链接会是 codebuddy.ai —— 国内账号在那边登不进去。
  node tools/install-cpa.mjs --download --yes --port "$CPA_PORT" --buddy-port "$APP_PORT" --oauth-region cn
fi

step "4/6 配成服务器模式（对外可连 + 随机管理口令）"
node - "$APP_PORT" <<'NODE'
const fs = require('node:fs')
const crypto = require('node:crypto')
const port = Number(process.argv[2]) || 8318
const file = 'data/config.json'
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
cfg.host = '0.0.0.0'
cfg.port = port
// 保留已有口令（重跑脚本时不要换来换去）
if (!cfg.adminPassword || String(cfg.adminPassword).length < 8) {
  cfg.adminPassword = crypto.randomBytes(9).toString('base64url')
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
fs.writeFileSync('data/admin-password.txt', cfg.adminPassword + '\n', { mode: 0o600 })
NODE
PASS="$(cat data/admin-password.txt)"
echo "管理口令：$PASS"

step "5/6 注册成系统服务（重启机器也会自己起来）"
$SUDO tee /etc/systemd/system/buddykey-cpa.service >/dev/null <<EOF
[Unit]
Description=BuddyKey upstream (CLIProxyAPI)
After=network.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$DIR/runtime/cpa
ExecStart=$DIR/runtime/cpa/cli-proxy-api
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

$SUDO tee /etc/systemd/system/buddykey.service >/dev/null <<EOF
[Unit]
Description=BuddyKey gateway
After=network.target buddykey-cpa.service
Wants=buddykey-cpa.service

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$DIR
ExecStart=$(command -v node) $DIR/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now buddykey-cpa buddykey

step "6/6 等它起来并自检"
for i in $(seq 1 30); do
  if curl -fsS -m 2 "http://127.0.0.1:$APP_PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
echo "--- /healthz ---"
curl -fsS -m 5 "http://127.0.0.1:$APP_PORT/healthz" || { echo "服务没起来，看日志：journalctl -u buddykey -n 50 --no-pager"; exit 1; }
echo
echo "--- 管理接口是否已受口令保护（应返回 401）---"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$APP_PORT/admin/api/state" || true)
echo "无凭据访问 -> $code $([ "$code" = 401 ] && echo '✓ 已保护' || echo '⚠️ 没受保护，请检查')"

IP=$(curl -s -m 5 https://api.ipify.org || echo '<你的公网IP>')
cat <<EOF

────────────────────────────────────────────
装好了。

管理页   http://$IP:$APP_PORT/
管理口令 $PASS
        （也存在 data/admin-password.txt）

下一步（只剩这一件）：
  在华为云安全组放行 $APP_PORT 端口，然后手机/电脑打开上面的地址，
  点「登录 WorkBuddy 账号」扫码。扫码完这个号就进池子了。

常用命令：
  看状态   $SUDO systemctl status buddykey --no-pager
  看日志   $SUDO journalctl -u buddykey -f
  重启     $SUDO systemctl restart buddykey buddykey-cpa
────────────────────────────────────────────
EOF

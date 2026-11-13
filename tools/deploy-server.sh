#!/usr/bin/env bash
#
# 一键在服务器上装好 BuddyKey 全套。
#
# 两种用法：
#   1) 已经 clone 好了：  bash tools/deploy-server.sh
#      —— 直接用当前这份代码，不会再往 /opt 克隆一份。
#   2) 全新机器：        git clone <仓库> /opt/buddykey && bash /opt/buddykey/tools/deploy-server.sh
#
# 可用环境变量覆盖（都有默认值，通常不需要动）：
#   BUDDYKEY_DIR       装到哪            默认：脚本所在仓库；否则 /opt/buddykey
#   BUDDYKEY_REPO      从哪克隆          默认：当前仓库的 origin；否则官方地址
#   BUDDYKEY_PORT      管理页/API 端口   默认 8318
#   BUDDYKEY_CPA_PORT  上游 CPA 端口     默认 8317（只绑 127.0.0.1，不对外）
#   BUDDYKEY_REGION    登录区域          cn（国内，默认）| intl（国际）
#
# 设计取舍：
#   - **非交互**：所有问题用默认值回答，装完把口令和地址打印出来。
#     远程终端里没人陪着一问一答，少一次输入就少一次出错机会。
#   - **绑定 0.0.0.0 + 随机口令**：服务器就是要给外面连的。口令是必须的，
#     否则 /admin/api/* 谁都能建 key 白嫖（服务端会拒绝在非本机地址上无口令启动）。
#   - **systemd 常驻**：这样重启机器也会自己起来，才真正是「不依赖电脑」。
#   - **不碰别人的进程**：只 enable 自己这两个 unit，不动系统里已有的服务。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_REPO="$(dirname "$SCRIPT_DIR")"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$1"; }

# 远程登录有时直接是 root，有时是普通用户。统一算一个前缀，别假设。
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

# ── 定位代码目录 ───────────────────────────────────────────────
# ⚠️ 如果脚本本身就在一个 git 仓库里（别人先 clone 再跑），就用它，
#   否则会往 /opt 再克隆一份，跑完两份代码、改哪份都不生效 —— 实测踩过。
if [ -n "${BUDDYKEY_DIR:-}" ]; then
  DIR="$BUDDYKEY_DIR"
elif [ -d "$SCRIPT_REPO/.git" ]; then
  DIR="$SCRIPT_REPO"
else
  DIR="/opt/buddykey"
fi

# 同理：从当前仓库的 origin 推，别人 fork 了也能装自己那份。
if [ -n "${BUDDYKEY_REPO:-}" ]; then
  REPO_URL="$BUDDYKEY_REPO"
elif [ -d "$SCRIPT_REPO/.git" ]; then
  REPO_URL="$(git -C "$SCRIPT_REPO" remote get-url origin 2>/dev/null || true)"
fi
# ⚠️ 自己 push 用的 remote 常是 SSH（git@github.com:…），而服务器上没有那把私钥。
#   把它换成 https 匿名地址 —— 仓库是公开的，不需要凭据。否则别人一跑就卡在
#   「Permission denied (publickey)」，而报错完全看不出是 remote 写法的问题。
case "${REPO_URL:-}" in
  git@github.com:*) REPO_URL="https://github.com/${REPO_URL#git@github.com:}" ;;
  git@ssh.github.com:*) REPO_URL="https://github.com/${REPO_URL#git@ssh.github.com:}" ;;
  ssh://git@github.com/*) REPO_URL="https://github.com/${REPO_URL#ssh://git@github.com/}" ;;
esac
if [ -z "${REPO_URL:-}" ]; then
  REPO_URL="https://github.com/cslkkl/cpa-Buddykey.git"
fi

APP_PORT="${BUDDYKEY_PORT:-8318}"
CPA_PORT="${BUDDYKEY_CPA_PORT:-8317}"
REGION="${BUDDYKEY_REGION:-cn}"

# ── 1. Node 与 git ────────────────────────────────────────────
step "1/6 装 Node 与 git"
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
fi

if [ "$NODE_MAJOR" -lt 20 ]; then
  # 按发行版选包管理器 —— 只认 apt 会让 CentOS / 阿里云 Linux / Fedora 直接失败。
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq curl ca-certificates git
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y -q curl ca-certificates git
  elif command -v yum >/dev/null 2>&1; then
    $SUDO yum install -y -q curl ca-certificates git
  else
    warn "认不出包管理器（不是 apt / dnf / yum）。请手动装好 curl、git、Node 20+ 后重跑。"
    exit 1
  fi

  # ⚠️ 不能写成 curl … | $SUDO -E bash -：SUDO 为空时那会变成 `| -E bash -`，
  #   bash 找不到叫 -E 的命令，直接失败。先落盘再执行，两种身份都成立。
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesetup.sh
  $SUDO bash /tmp/nodesetup.sh
  rm -f /tmp/nodesetup.sh

  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get install -y -qq nodejs
  else
    $SUDO dnf install -y -q nodejs 2>/dev/null || $SUDO yum install -y -q nodejs
  fi
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Node 还是 $NODE_MAJOR 版，至少要 20。装失败了？看上面 apt/dnf 的输出。"
  exit 1
fi
echo "node $(node -v) / git $(git --version | awk '{print $3}')"

# ── 2. 代码 ──────────────────────────────────────────────────
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
echo "代码在 $DIR（$(git rev-parse --short HEAD 2>/dev/null || echo '无 git 信息')）"

# ── 3. 上游 ──────────────────────────────────────────────────
step "3/6 装上游（CPA 本体 + workbuddy 插件，约 30 MB，等 1-2 分钟）"
if [ -f runtime/cpa/config.yaml ]; then
  echo "已经装过了，跳过（要重装用 --force，或先删掉 runtime/）"
else
  # --oauth-region：cn = copilot.tencent.com（国内），intl = codebuddy.ai。
  # 不传的话插件默认 intl，登录链接会是 codebuddy.ai —— 国内账号在那边登不进去。
  node tools/install-cpa.mjs --download --yes \
    --port "$CPA_PORT" --buddy-port "$APP_PORT" --oauth-region "$REGION"
fi

# ── 4. 服务器模式 ────────────────────────────────────────────
step "4/6 配成服务器模式（对外可连 + 随机管理口令）"
node - "$APP_PORT" <<'NODE'
const fs = require('node:fs')
const crypto = require('node:crypto')
const port = Number(process.argv[2]) || 8318
const file = 'data/config.json'
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
cfg.host = '0.0.0.0'
cfg.port = port
// 保留已有口令（重跑脚本时不要换来换去，否则浏览器里存的那个立刻失效）
if (!cfg.adminPassword || String(cfg.adminPassword).length < 8) {
  cfg.adminPassword = crypto.randomBytes(9).toString('base64url')
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
fs.writeFileSync('data/admin-password.txt', cfg.adminPassword + '\n', { mode: 0o600 })
NODE
PASS="$(cat data/admin-password.txt)"
echo "管理口令：$PASS"

# ── 5. systemd ───────────────────────────────────────────────
step "5/6 注册成系统服务（重启机器也会自己起来）"
if ! command -v systemctl >/dev/null 2>&1; then
  warn "这台机器没有 systemd，跳过。请自行用 nohup / screen 常驻："
  warn "  $DIR/runtime/cpa/cli-proxy-api  与  node $DIR/server.mjs"
else
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
fi

# ── 6. 自检 ──────────────────────────────────────────────────
step "6/6 等它起来并自检"
for _ in $(seq 1 30); do
  if curl -fsS -m 2 "http://127.0.0.1:$APP_PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
echo "--- /healthz ---"
curl -fsS -m 5 "http://127.0.0.1:$APP_PORT/healthz" || {
  warn "服务没起来。看日志：journalctl -u buddykey -n 50 --no-pager"
  exit 1
}
echo
echo "--- 管理接口是否已受口令保护（应返回 401）---"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$APP_PORT/admin/api/state" || true)
echo "无凭据访问 -> $code $([ "$code" = 401 ] && echo '✓ 已保护' || echo '⚠️ 没受保护，请检查')"

IP=$(curl -s -m 5 https://api.ipify.org 2>/dev/null || echo '<你的公网IP>')
cat <<EOF

────────────────────────────────────────────
装好了。

管理页   http://$IP:$APP_PORT/
管理口令 $PASS
        （也存在 $DIR/data/admin-password.txt）

下一步（只剩这两件）：

1. 放行 $APP_PORT 端口
   在云厂商控制台的「安全组 / 防火墙」里加一条入方向规则：
     协议 TCP，端口 $APP_PORT，源 0.0.0.0/0
   （华为云叫「安全组」，阿里云叫「安全组」，腾讯云叫「安全组」，
     AWS 叫 Security Group，Vultr / DigitalOcean 叫 Firewall）

2. 打开 http://$IP:$APP_PORT/ 输口令，点「登录 WorkBuddy 账号」扫码
   扫码完这个号就进池子，然后点「创建 API key」拿 sk-pool-…
   软件里填：Base URL  http://$IP:$APP_PORT/v1 ，模型 deepseek-v4.1-flash

常用命令：
  看状态   $SUDO systemctl status buddykey --no-pager
  看日志   $SUDO journalctl -u buddykey -f
  重启     $SUDO systemctl restart buddykey buddykey-cpa

⚠️ 地址是 http 不是 https —— key 在网络上是明文。
   要加密就配个域名 + nginx，见 docs/DEPLOY-SERVER.md
────────────────────────────────────────────
EOF

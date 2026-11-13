# 部署到自己的服务器

目标：**电脑关机，手机上照样能用。** 本机部署做不到这一点（两个环节都在本机）。

本文以 Ubuntu 24.04 / 2 核 4 G / 公网 IP 为例，命令可以直接粘。

> 先读一句话结论：**不要直接把端口开到公网。**
> 管理接口能读账号池、能给自己发 key。必须设口令 + 走反向代理，本文第 4 节。

## 懒人版：一条命令

只要机器是 Ubuntu / Debian / CentOS / 阿里云 Linux 之类，root 或能 sudo 就行：

```bash
git clone https://github.com/cslkkl/cpa-Buddykey.git ~/buddykey
sudo bash ~/buddykey/tools/deploy-server.sh
```

它做完第 1、3、4、6 节的全部事情，最后打印公网地址和随机管理口令。
剩下只有两件人为的事：**放行端口**（第 8 节）、**扫码登录账号**。

脚本认这些环境变量，需要时覆盖：

```bash
sudo BUDDYKEY_PORT=9000 BUDDYKEY_REGION=intl bash tools/deploy-server.sh
```

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `BUDDYKEY_DIR` | 当前仓库 / `/opt/buddykey` | 装到哪 |
| `BUDDYKEY_REPO` | 当前仓库的 origin（自动转成 https） | 从哪克隆 |
| `BUDDYKEY_PORT` | `8318` | 管理页与 API 端口 |
| `BUDDYKEY_CPA_PORT` | `8317` | 上游 CPA 端口（只绑 127.0.0.1） |
| `BUDDYKEY_REGION` | `cn` | 登录区域：`cn` 国内 / `intl` 国际 |

想看每一步在做什么、或者想自己掌控节奏 → 往下读手工版。

## 0. 为什么值得搬到服务器

| | 本机 | 服务器 |
| --- | --- | --- |
| 电脑关机 | 全断 | 照常用 |
| 地址 | 隧道每次重启换域名 | 固定 IP / 域名 |
| 多设备 | 连同一台电脑 | 都连同一个地址 |
| 登录态 | 占本机磁盘 | 留在服务器 |

**服务器不会给你更多额度** —— 额度还是那些 WorkBuddy 账号的，它只买「一直在线」。

## 1. 装 Node

```bash
sudo apt update && sudo apt install -y curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v    # 需要 >= 20
```

## 2. 拉代码

```bash
sudo mkdir -p /opt && cd /opt
sudo git clone https://github.com/cslkkl/cpa-Buddykey.git buddykey
sudo chown -R "$USER":"$USER" buddykey
cd buddykey
```

仓库是公开的，**不需要任何凭据**就能 clone。
如果你 fork 了自己的版本，把地址换成你那份即可。

不需要 `npm install` —— 这个项目零 npm 依赖。

## 3. 装上游（CPA + workbuddy 插件）

```bash
npm run install-cpa
```

它会自动选 **Linux 的 `.tar.gz`**（Windows 才是 `.zip`），四个问题全按回车。

装完检查：

```bash
ls runtime/cpa/            # 应该有 cli-proxy-api（可执行）
ls runtime/cpa/plugins/    # 应该有 workbuddy.so
```

> 如果报「release 里没有匹配 … 的资产」，说明架构不被上游支持
> （目前只有 amd64 与 aarch64）。`uname -m` 看一眼。

## 4. 先手动起一次，登录账号

```bash
# 终端 A
npm run cpa

# 终端 B
npm start
```

浏览器打开 `http://<公网IP>:8318/`，点「登录 WorkBuddy 账号」扫码。

**这一步必须在能看到浏览器的地方做。** 如果服务器只有命令行，两个办法：

- 用 SSH 端口转发，把远程端口映射到本机浏览器：
  ```bash
  ssh -L 8318:127.0.0.1:8318 <user>@<服务器IP>
  # 然后本机浏览器开 http://127.0.0.1:8318/
  ```
- 或者先在能上网的电脑上登录，把 `~/.cli-proxy-api/workbuddy-*.json` 拷到服务器同一位置。

登录成功后页面会显示池子里有账号，接着「创建 API key」拿一把。

## 5. 上公网之前：设管理口令（**必做**）

现在管理接口是不设防的。实测过：

```bash
# 没有口令时，任何人都能这么做
curl -X POST http://<IP>:8318/admin/api/keys -d '{"name":"白嫖"}'
# → 200，直接拿到一把能用的 key，消耗你的额度
```

所以本项目的规则是 **fail closed**：监听地址不是本机、又没设口令时，**直接拒绝启动**。

设口令（任选一种）：

```bash
# A. 写进配置（推荐；一键脚本就是这么做的，还会顺手存一份到 data/admin-password.txt）
node -e '
  const fs = require("fs");
  const f = "data/config.json";
  const c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.adminPassword = require("crypto").randomBytes(12).toString("base64url");
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
  console.log("口令：" + c.adminPassword);
'

# B. 或者交给 systemd 环境变量（见第 6 节）
```

然后页面首次打开会弹口令框，输入后存在该标签页里，关掉即失效（`sessionStorage`，不写 cookie）。

验证口令真的生效了 —— **这一步别省**：

```bash
# 期望 401（被挡住），不是 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8318/admin/api/state

# 期望 200（带对口令）
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "authorization: Bearer 你的口令" http://127.0.0.1:8318/admin/api/state
```

## 6. 用 systemd 常驻

```bash
sudo tee /etc/systemd/system/buddykey-cpa.service >/dev/null <<'EOF'
[Unit]
Description=BuddyKey upstream (CLIProxyAPI)
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/opt/buddykey/runtime/cpa
# CPA 按相对路径找 config.yaml 与 plugins/，所以工作目录必须是它自己的
ExecStart=/opt/buddykey/runtime/cpa/cli-proxy-api
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/buddykey.service >/dev/null <<'EOF'
[Unit]
Description=BuddyKey gateway
After=network.target buddykey-cpa.service
Wants=buddykey-cpa.service

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/opt/buddykey
ExecStart=/usr/bin/node /opt/buddykey/server.mjs
Restart=always
RestartSec=3
# 管理口令放这里，不要写进仓库
# Environment=BUDDYKEY_ADMIN_PASSWORD=换成你自己的口令

[Install]
WantedBy=multi-user.target
EOF

sudo sed -i "s/YOUR_USER/$USER/g" /etc/systemd/system/buddykey*.service
sudo systemctl daemon-reload
sudo systemctl enable --now buddykey-cpa buddykey
sudo systemctl status buddykey --no-pager -l
```

看日志：

```bash
sudo journalctl -u buddykey -f
```

## 7. 只把 `/v1` 露给公网，管理页留在本机

推荐做法：BuddyKey 仍只绑 `127.0.0.1`，用 nginx 只反代 `/v1`。

```bash
sudo apt install -y nginx
```

`/etc/nginx/sites-available/buddykey`：

```nginx
server {
    listen 80;
    server_name api.example.com;

    # 只反代数据面。管理接口 /admin/* 故意不转发 ——
    # 需要管理时用 SSH 隧道（第 4 节），不要开到公网。
    location /v1/ {
        proxy_pass http://127.0.0.1:8318;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;          # 流式响应必须关掉缓冲
        proxy_read_timeout 600s;
        client_max_body_size 32m;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/buddykey /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**这一步之后 `data/config.json` 里 `host` 保持 `127.0.0.1` 即可**，不用改 `0.0.0.0`
—— nginx 和它同机，走回环就够。这样管理接口天然不暴露，也就不需要口令了。

要 HTTPS 就再装 certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.example.com
```

## 8. 打开云厂商的安全组

云主机的防火墙有**两层**：系统内的 ufw / firewalld，以及控制台的「安全组」。
两层都放行才通。只改一层是最常见的「明明服务在跑却连不上」原因。

### 两种模式，选一种

**A. 简单模式（一键脚本默认走这条）**

直接开端口，靠**管理口令**挡住 `/admin/api/*`：

| 端口 | 开给谁 | 用途 |
| --- | --- | --- |
| 22 | 你的 IP（或 0.0.0.0/0） | SSH / 网页终端 |
| **8318** | **0.0.0.0/0** | 管理页 + API，**必须有管理口令** |
| 8317 | 不要开 | CPA 本体，只绑 127.0.0.1 |

适用：自己一个人用，手机要直接连。
代价：管理页暴露在公网，安全性完全依赖那个口令（以及地址不被扫到）。
**服务端会在非本机地址 + 无口令时拒绝启动**，所以不会出现「忘了设口令就裸奔」。

**B. 稳妥模式**

只开 80 / 443，用它做反向代理**只转发 `/v1`**，管理页留在本机：

| 端口 | 开给谁 | 用途 |
| --- | --- | --- |
| 22 | 你的 IP | SSH |
| 80 / 443 | 0.0.0.0/0 | nginx 反向代理 |
| 8318 | **不要开** | 管理页，走 SSH 隧道 |
| 8317 | **不要开** | CPA 本体 |

适用：要 HTTPS、要给别人用、不想让管理页暴露。
完整 nginx 配置与 HTTPS（certbot）见**第 7 节**，这里不重复。
管理页这样访问：`ssh -L 8318:127.0.0.1:8318 用户@服务器IP`，
然后开 `http://127.0.0.1:8318/`。

### 各家控制台在哪

| 厂商 | 叫法 | 位置 |
| --- | --- | --- |
| 华为云 | 安全组 | 实例详情 → 安全组 → 配置规则 → 入方向 |
| 阿里云 | 安全组 | ECS → 安全组 → 配置规则 |
| 腾讯云 | 安全组 | 轻量/CVM → 防火墙 |
| AWS | Security Group | EC2 → Security → Security Groups |
| Vultr / DigitalOcean | Firewall | 实例 → Settings → Firewall |

## 9. 验收清单

搬完之后逐条打勾。**前两条不通就别往下试** —— 它们排除的是环境问题，不是配置问题。

```bash
# 1. 两个服务都在跑
systemctl is-active buddykey-cpa buddykey        # 两个都应是 active

# 2. 本机能读（服务自身活着）
curl -s http://127.0.0.1:8318/healthz | head -c 300
#    关注 modelSource：probe = 从 CPA 真探到了；fallback = 没探到（多半还没登录账号）

# 3. 管理接口确实被口令挡住（简单模式必查；稳妥模式返回 404 也算对）
curl -s -o /dev/null -w 'no-auth  -> %{http_code}\n' http://127.0.0.1:8318/admin/api/state
curl -s -o /dev/null -w 'with-pw  -> %{http_code}\n' \
  -H "authorization: Bearer 你的口令" http://127.0.0.1:8318/admin/api/state
#    期望 401 / 200。两个都 200 = 口令没生效，立刻停下来查

# 4. 数据面能真调（用页面创建出来的 key）
curl -s http://127.0.0.1:8318/v1/chat/completions \
  -H "Authorization: Bearer sk-pool-你的key" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":10}' \
  | head -c 300
#    期望 200 且 choices[0].message.content 有内容

# 5. 从公网访问（把 IP 换成你的）
curl -s -o /dev/null -w 'public   -> %{http_code}\n' http://你的IP:8318/healthz
#    200 = 端口通了。超时 = 安全组没放行（第 8 节）
```

第 5 条通了之后，才算「电脑关机也能用」这件事真的成立。

## 10. 服务器上会踩的坑

**① 账号目录是固定的 `~/.cli-proxy-api`。** 同机多份 CPA 共用账号，不会隔离。
服务器上通常只有一份，问题不大；本机调试时要注意别以为自己「装了个干净的」。

**② 换插件版本前必须停 CPA。** Linux 上被 `dlopen` 的 `.so` 也改不了名：

```bash
sudo systemctl stop buddykey-cpa
node tools/cpa-update.mjs --apply
sudo systemctl start buddykey-cpa
```

页面上的「更新」按钮要求 CPA 停着，systemd 管着的时候它会拒绝 —— 这是有意的。

**③ 登录区域要在登录之前定，改区域要重新授权。**
`cn` 与 `intl` 签发的 OAuth state 不通用（在 `.ai` 上签的拿到 `.cn` 页面会被拒，HTTP 400）。
所以换区域之后，页面上的旧登录框要先「取消授权」，再点「登录」：

```bash
sudo npm run oauth-region cn          # cn 国内 / intl 国际
sudo systemctl restart buddykey-cpa buddykey
```

**④ 代理 / VPN 会让 `git pull` 卡住而不是失败。**
国内机器连 `github.com` 可能握手挂住，`git clone` 就一直停在原地（不报错）。
`api.github.com` 通常是通的 —— 所以安装器只走它。
真拉不动代码时，用 `curl` 从 `api.github.com` 取，别死等 `git clone`。

**⑤ 带宽是小云机最容易忽略的限制。**
2 核 4 G 的机器常配 3 Mbit/s 峰值。文字对话完全够；
但一次长回复几十 KB、多人同时用，就会明显变慢 —— 这不是配置问题，是套餐限制。

## 11. 想省钱的话

- 这个服务很轻：**1 核 1 G 够用**（CPA 本身几十 MB 内存）。
- 流量主要花在模型输出上，但走的是你服务器到客户端；**3 Mbit/s 峰值带宽**
  意味着大段输出会慢。够手机上问问题用，不适合传大文件。
- 不需要 GPU、不需要数据库、不需要对象存储。

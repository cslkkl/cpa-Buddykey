# 部署到自己的服务器

目标：**电脑关机，手机上照样能用。** 本机部署做不到这一点（两个环节都在本机）。

本文以 Ubuntu 24.04 / 2 核 4 G / 公网 IP 为例，命令可以直接粘。

> 先读一句话结论：**不要直接把端口开到公网。**
> 管理接口能读账号池、能给自己发 key。必须设口令 + 走反向代理，本文第 4 节。

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
sudo git clone <仓库地址> buddykey
sudo chown -R "$USER":"$USER" buddykey
cd buddykey
```

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
# A. 写进配置
node -e '
  const fs=require("fs"); const f="data/config.json";
  const c=JSON.parse(fs.readFileSync(f,"utf8"));
  c.adminPassword=require("crypto").randomBytes(12).toString("base64url");
  fs.writeFileSync(f,JSON.stringify(c,null,2));
  console.log("口令：" + c.adminPassword);
'

# B. 或者交给 systemd 环境变量（见第 6 节）
```

然后页面首次打开会弹口令框，输入后存在该标签页里，关掉即失效。

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

华为云 / 阿里云 / 腾讯云都要单独放行端口，**Ubuntu 的 ufw 之外还有一层**：

| 端口 | 开给谁 | 用途 |
| --- | --- | --- |
| 22 | 你的 IP | SSH |
| 80 / 443 | 0.0.0.0/0 | 如果走 nginx |
| 8318 | **不要开** | 管理页，走 SSH 隧道 |
| 8317 | **不要开** | CPA 本体，只该被本机访问 |

> 我这边连你服务器的 22 端口是超时的，说明安全组还没放行
> （或者只对特定 IP 开放）。

## 9. 验收清单

搬完之后逐条打勾：

```bash
# 1. 两个服务都在跑
systemctl is-active buddykey-cpa buddykey        # 两个都应是 active

# 2. 本机能读管理接口（经 SSH 隧道）
curl -s http://127.0.0.1:8318/healthz | head -c 300

# 3. 数据面能调（用创建出来的 key）
curl -s http://127.0.0.1:8318/v1/chat/completions \
  -H "Authorization: Bearer sk-pool-你的key" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}' \
  | head -c 300

# 4. 从公网只能碰 /v1，管理接口被挡住
curl -s -o /dev/null -w '%{http_code}\n' http://<域名>/admin/api/state   # 应 404
```

## 10. 这台服务器上的两个坑

**① 账号目录是固定的 `~/.cli-proxy-api`。** 同机多份 CPA 共用账号，不会隔离。
服务器上通常只有一份，问题不大；本机调试时要注意别以为自己「装了个干净的」。

**② 换插件版本前必须停 CPA。** Linux 上被 `dlopen` 的 `.so` 也改不了名：

```bash
sudo systemctl stop buddykey-cpa
node tools/cpa-update.mjs --apply
sudo systemctl start buddykey-cpa
```

页面上的「更新」按钮要求 CPA 停着，systemd 管着的时候它会拒绝 —— 这是有意的。

## 11. 想省钱的话

- 这个服务很轻：**1 核 1 G 够用**（CPA 本身几十 MB 内存）。
- 流量主要花在模型输出上，但走的是你服务器到客户端；**3 Mbit/s 峰值带宽**
  意味着大段输出会慢。够手机上问问题用，不适合传大文件。
- 不需要 GPU、不需要数据库、不需要对象存储。

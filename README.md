<h1 align="center">BuddyKey</h1>

<p align="center">
把多个 WorkBuddy 账号的额度，变成一排<strong>可撤销、可限额、可限定账号</strong>的 API Key。
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520-3c873a">
  <img alt="Deps" src="https://img.shields.io/badge/dependencies-0-0071e3">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-000000">
</p>

## 它解决什么

一个人手里常有多个 WorkBuddy 账号，额度分散；直接共用一个 token 又无法区分「谁在花、花多少」。
BuddyKey 在中间加一层薄网关：

- **登录即入池**：点一次「登录 WorkBuddy 账号」，授权完这个号就进池子，余额可见。
- **一把钥匙一个身份**：每把 key 有名字、Tracking ID、遮罩显示、创建与最近使用时间。
- **每把 key 独立限额**：每日请求数 / 每日积分，超了直接 429，不消耗上游额度。
- **每把 key 限定账号**：只允许落在指定的几个号上。
- **只放行一个模型**：workbuddy 渠道的 `deepseek-v4.1`，其余一律 404。

协议是 OpenAI 兼容的，任何 SDK 改个 `base_url` 就能用。

## 快速上手

前提：本机已装 Node ≥ 20，且 CPA（`cli-proxy-api`）在 `127.0.0.1:8317` 上跑着并登录过 WorkBuddy 账号。

```bash
# 1. 启动
npm start                     # 或双击 start.cmd

# 2. 打开管理页，登录账号、创建 key
#    http://127.0.0.1:8318/

# 3. 用它
curl http://127.0.0.1:8318/v1/chat/completions \
  -H "Authorization: Bearer sk-pool-你的key" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4.1","messages":[{"role":"user","content":"你好"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8318/v1", api_key="sk-pool-...")
client.chat.completions.create(model="deepseek-v4.1", messages=[{"role": "user", "content": "你好"}])
```

手机上用（任意网络）：`start-tunnel.cmd` 起一条 cloudflared 隧道，
把打印出来的 `https://xxx.trycloudflare.com/v1` 填进 App。

## 数据留在哪

- key 明文、调用账本、配置：`data/`（本机，不入库、不出网）。
- 账号登录态：由 CPA 保存在 `~/.cli-proxy-api/`，BuddyKey 不复制。
- 管理密钥：从 `~/.dsh/.credentials.yaml` 的 `refs` 段现取，不落第二份。

## 已知限制

- 账号范围是**全局切换**实现的（CPA 没有按 key 绑定账号的能力），
  并发不同范围的 key 会排队。原因与替代方案见
  [决策记录](.agents/notes/2026-11-12-account-scope-via-toggle.md)。
- 隧道是临时的：重启即换域名；公网暴露只靠 `sk-pool-` 这把 key 拦人。

## 文档

- 设计与防错清单 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 维护索引与常用命令 → [AGENTS.md](AGENTS.md)
- 交接与后续计划 → [docs/PLAN.md](docs/PLAN.md)

## License

MIT

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

## 它不做什么

这一层**不提供额度，也不替你登录 WorkBuddy**。它前面必须有
[CPA（CLIProxyAPI）](https://github.com/router-for-me/CLIProxyAPI) 在跑，
且 CPA 里已经装好 workbuddy 渠道插件、登好至少一个 WorkBuddy 账号。

```
你的客户端 ──sk-pool-…──▶ BuddyKey ──▶ CPA ──▶ WorkBuddy 上游
                              ↑           ↑
                        具名 key/限额   账号池/额度
```

所以「拉下来就能用」的准确含义是：**CPA 那边已经就绪的人**，拉下来配两个密钥、十分钟内就能发出第一个请求。

## 从零到第一个请求

### 0. 前提

| 需要 | 怎么确认 |
| --- | --- |
| Node ≥ 20 | `node -v` |
| CPA 在 `127.0.0.1:8317` 上跑着 | `curl http://127.0.0.1:8317/v1/models` 有响应 |
| CPA 里装好 workbuddy 插件 | CPA 配置里 `plugins.configs.workbuddy.enabled: true` |
| 至少登录过一个 WorkBuddy 账号 | CPA 的 `~/.cli-proxy-api/workbuddy-*.json` 存在 |

> workbuddy 渠道插件目前只有 Windows 版（`workbuddy.dll`），Linux/macOS 上跑不了这个渠道。

### 1. 拿到两个密钥

打开 CPA 的 `config.yaml`（常见位置：`~/.dsh/cpa-panel/runtime/cpa/config.yaml`
或 `~/.cli-proxy-api/config.yaml`）：

```yaml
access:
    api-keys:
        - "sk-cpa-local-2026"        # ← 第 1 个：上游 API key，明文，脚本能自动读到

management:
    secret-key: "$2a$10$...."        # ← 第 2 个：管理密钥，注意这是 bcrypt 哈希
```

- **上游 API key**：`access.api-keys` 的第一条，**明文**，`npm run setup` 会自动替你填。
- **管理密钥**：`management.secret-key` 要填的是它的**明文原值**。
  配置文件里存的可能是 bcrypt（`$2a$…`）哈希 —— 哈希还原不出明文，
  要用你当初设置的那个值；忘了就去 CPA 面板重置一个。
  明文输错的代价很直接：见下面的「IP 封禁」。

### 2. 配好并启动

```bash
npm run setup          # 一问一答；上游 key 自动嗅探，管理密钥粘进去
npm start              # 或双击 start.cmd
```

`npm run setup` 会写 `data/config.json` 并立刻校验一次管理密钥。看到这行就算配对了：

```
✓ 管理密钥有效，CPA 里读到 8 个凭据文件。
```

不想用交互脚本，就手写 `data/config.json`（从 `config.sample.json` 复制）填这两个字段：

```json
{ "upstreamKey": "sk-cpa-local-2026", "adminKey": "<management.secret-key 的明文>" }
```

或者用环境变量（适合容器 / CI）：

```bash
BUDDYKEY_UPSTREAM_KEY=sk-… BUDDYKEY_ADMIN_KEY=… npm start
```

三个来源优先级：`config.json` > 环境变量 > `~/.dsh/.credentials.yaml`。

### 3. 登录账号、创建 key

打开 <http://127.0.0.1:8318/> ：

1. 切到「账号」视图 → 点「登录 WorkBuddy 账号」→ 扫码授权，这个号就进池子了；
2. 回「API Keys」视图 → 点「创建 API key」→ 填名字、限额、账号范围；
3. **明文只显示这一次**，点「复制」保存好（丢了只能删了重建）。

如果池子或密钥还没就绪，页面顶部会有一张「还差一步就能用」的卡片，
逐条告诉你缺什么、去哪填、当前密钥是从哪个来源读到的 —— 不用回来翻这份文档。

### 4. 发出第一个请求

```bash
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
隧道二进制要自己下到 `bin/cloudflared.exe`（不入库）。

## 常见问题

**`IP banned due to too many failed attempts. Try again in 29m41s`**

CPA 对管理接口有 IP 级失败计数：连续用错的管理密钥会被封约 30 分钟，期间**每次重试都会重新计时**。
数据面 `/v1` 通常不受影响，只有读账号列表、登录、改账号开关会失败。
处理办法：等它到期。如果这个 IP 有别人在用，去找真正的原因（密钥填错？从别的机器连过来？），别再重试。
BuddyKey 会把这条信息翻译成人话显示，并在 `npm run setup` 写完后主动校验一次 —— 就是为了让你早点发现，而不是起服务后才撞上。

**页面显示「池子读不到：还没配置管理密钥」**

`adminKey` 没配上。去 `data/config.json` 填，或重跑 `npm run setup`。
`/healthz` 的 `adminKeyFrom` 字段会告诉你当前是从 `config` / `env` / `refs` / `none` 的哪一路读到的。

**调模型回 401 `Incorrect API key provided`**

用的是 BuddyKey 签发的 `sk-pool-…`，不是 CPA 的 `sk-cpa-…`。两者不通用。

**调模型回 502 `upstream_unreachable`**

CPA 没起，或者 `upstream` 地址不对。先 `curl http://127.0.0.1:8317/v1/models` 确认。

**端口 8318 被占**

改 `data/config.json` 的 `port`，或者设 `PORT` 之外的方式：直接改配置文件最稳。

## 数据留在哪

- key 明文、调用账本、配置：`data/`（本机，不入库、不出网）。
  ⚠️ `data/config.json` 里有 CPA 的两个密钥明文 —— 别提交、别外发。
- 账号登录态：由 CPA 保存在 `~/.cli-proxy-api/`，BuddyKey 不复制。
- 管理密钥：默认从 `data/config.json` / 环境变量读；
  这台机器上装了 dsh-cpa-switch 的话，也可以继续从 `~/.dsh/.credentials.yaml` 的 `refs` 段取。

## 已知限制

- 账号范围是**全局切换**实现的（CPA 没有按 key 绑定账号的能力），
  并发不同范围的 key 会排队。原因与替代方案见
  [决策记录](.agents/notes/2026-11-12-account-scope-via-toggle.md)。
- 范围请求结束时的还原发生在**响应之后**约 100ms，这期间本机其它直连 CPA 的客户端会看到被截窄的池子。
  细节见 [架构说明](docs/ARCHITECTURE.md)。
- 隧道是临时的：重启即换域名；公网暴露只靠 `sk-pool-` 这把 key 拦人。
- 电脑关机即断：整条链路两环在本机，账号登录态也在本机磁盘。

## 文档

- 设计与防错清单 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 维护索引与常用命令 → [AGENTS.md](AGENTS.md)
- 交接与后续计划 → [docs/PLAN.md](docs/PLAN.md)

## 开发与自测

不需要真 CPA 也能测上游相关的分支：

```bash
npm run fake-cpa            # 假 CPA，起在 127.0.0.1:8390
# admin key: fake-admin-key   upstream key: fake-upstream-key
```

它实现了 BuddyKey 用到的全部接口（账号 / 余额 / 登录 / 开关 / 改模型），
还会模拟「连续输错管理密钥 → IP 封禁」的行为（阈值调成 3 次，方便复现）。
把 `upstream` 指到它就切断了与真实账号池的关系。

```bash
npm run check               # 四个 .mjs 的语法自检
npm run check:docs          # 文档相对链接 + 换行约定
```

## License

MIT

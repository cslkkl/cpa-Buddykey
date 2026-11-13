<h1 align="center">BuddyKey</h1>

<p align="center">
把多个 WorkBuddy 账号的额度，变成一排<strong>可撤销、可限额、可限定账号</strong>的 API Key。
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520-3c873a">
  <img alt="Deps" src="https://img.shields.io/badge/dependencies-0-0071e3">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-000000"></a>
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

这一层**不提供额度，也不替你登录 WorkBuddy** —— 授权必须你本人扫码。

上游那一层（[CPA（CLIProxyAPI）](https://github.com/router-for-me/CLIProxyAPI) 本体 +
workbuddy 渠道插件 + 配置）由 `npm run install-cpa` 自动装进项目里，
所以不用你自己去找、去配。

```
你的客户端 ──sk-pool-…──▶ BuddyKey ──▶ CPA ──▶ WorkBuddy 上游
                              ↑           ↑
                        具名 key/限额   账号池/额度
                          （本层）    （安装器负责）
```

所以「拉下来就能用」的准确含义是：**拉下来 → 跑安装器 → 扫码登录一次**，
之后就有自己的 key 与额度池了。

## 从零到第一个请求

**只需要两步，加上一次扫码。** 项目自带安装器，会把上游那一层（CPA 本体 + workbuddy
渠道插件 + 配置）一并装进 `runtime/`，不用你自己去找、去配。

```bash
npm run install-cpa      # 下载 CPA + 插件，生成配置（约 30 MB，一次性）
npm run cpa              # 起上游（新窗口，别关）
npm start                # 起 BuddyKey（另一个窗口）
```

然后打开 <http://127.0.0.1:8318/>，点「登录 WorkBuddy 账号」扫码 ——
**这是唯一需要你本人做的步骤**，因为授权只能人来做。登录完这个号就进池子，
接着创建 API key 就能用了。

> **不装 npm 包**：这个项目零依赖，`npm install` 不用跑。
> 需要 Node ≥ 20（仓库带 `.node-version`）。

### 想摆脱「电脑必须开着」

本机部署的代价是：关机就断、隧道每次重启换域名、多设备要连同一台电脑。
搬到一台常年在线的服务器上就没有这些限制。

**有服务器的话，一条命令搞定：**

```bash
git clone https://github.com/cslkkl/cpa-Buddykey.git ~/buddykey
sudo bash ~/buddykey/tools/deploy-server.sh
```

跑完会打印**公网地址**和**随机管理口令**。脚本自动做完这些：

1. 装 Node 20+ 与 git（apt / dnf / yum 都认）
2. 下载上游 CPA + workbuddy 插件（约 30 MB，校验 sha256）
3. 配成对外可连 + 生成随机管理口令
4. 注册 systemd 服务，**开机自启**
5. 自检：服务活着、管理接口确实返回 401

剩下的只有两件人为的事：**在云厂商控制台放行端口**、**扫码登录账号**。

不想一条命令而是想看每一步在干什么 → [部署到服务器](docs/DEPLOY-SERVER.md)。

⚠️ **上公网前必须设管理口令**（脚本会自动生成）。管理接口能读账号池、能给自己发 key；
不设口令时，本项目会**拒绝在非本机地址上启动**，而不是裸奔。

### 这台机器上已经有 CPA 怎么办

安装器会先探测，找到就**默认复用、不覆盖**：

```bash
npm run install-cpa -- --reuse     # 接上已有的那份
npm run install-cpa -- --download  # 强制装一份本项目专用的
```

已有 CPA 可能在 `~/.dsh/cpa-panel/runtime/cpa` 或 `~/.cli-proxy-api`。
它会读出那份 `config.yaml` 里的 `access.api-keys` 与 `management.secret-key` 来填
BuddyKey 的配置；如果那个 secret 是 bcrypt 哈希（`$2a$…`）而读不出明文，
会提示你手填原值。

### 安装器具体做了什么

| 步骤 | 内容 | 来源 |
| --- | --- | --- |
| 1 | 下载 CPA 本体并解出 `cli-proxy-api.exe` | `router-for-me/CLIProxyAPI` 最新 release |
| 2 | 下载 workbuddy 渠道插件 | 官方插件商店 `CLIProxyAPI-Plugins-Store` registry 指向的 release |
| 3 | 生成最小 `config.yaml`（只开 workbuddy 一个渠道） | 本地生成 |
| 4 | 把两个密钥写进 `data/config.json` | 本地生成 |

两点值得说明：

- **每次下载都校验 sha256**，对不上就不落盘 —— 这两个包都是第三方二进制。
- 全部落在 `runtime/`（已 gitignore）。删掉这个目录 = 卸掉上游，不影响 BuddyKey 自身。

### 模型名不用你操心

插件不同版本的前缀不一样（`wb/deepseek-v4.1-flash` / `cn/deepseek-v4.1-flash`…），
所以 BuddyKey 默认**启动时问一次 CPA**，用真实存在的那个，并同时接受短别名
（`deepseek-v4.1-flash`、`deepseek-v4.1`）。`/healthz` 的 `modelSource`
会告诉你这个模型名是探到的（`probe`）还是配置里写死的（`config`）。

要固定成某个值，就在 `data/config.json` 里写 `"model": "..."`。

### 插件有新版时会告诉你，但不会自己换

页面「连通状态」下面有一行显示上游版本：

| 显示 | 含义 | 按钮 |
| --- | --- | --- |
| `已是 v0.10.0，与上游一致` | 装的就是上游最新版 | 无（陈述句不需要动作） |
| `v0.9.9 → v0.10.0` | 有新版 | 「更新」 |
| `已装版本未知（本版未记录）· 上游当前 v0.10.0` | 老版本装的，没记 tag | 「更新」 |
| `查不到上游版本：…` | 断网 / 限流 | 「重试」 |

**为什么不自动升级**：这个插件不是本项目维护的，它随时可能改行为（模型前缀就变过一次）。
静默替换等于把上游的风险直接灌给你。所以这边只做「如实报告 + 你点了才换」。

判据是 **release 的 tag 是否相等**，不解析版本号 —— 两个 tag 都摆出来，谁新谁旧你自己看。
这也意味着：如果上游**重打包同一个 tag**，这里会说「已是最新」而内容其实换了。
不假装它比 tag 更准。

点「更新」时会发生什么，按顺序：

1. 先确认 CPA **没在跑**。Windows 上被加载的 dll 改不了名，所以服务端会先探一下上游；
   如果 CPA 还活着（哪怕回 401 也算活着），**直接拒绝**并告诉你先去那个窗口按 Ctrl+C。
   它不会替你杀进程 —— 杀掉一个自己没启动的进程和杀自己的是两件事。
2. 下载 → **校验 sha256** → 备份旧的 → 清空目录 → 解压 → 记下新 tag。
   任何一步失败都把旧件放回原位，不会留下一个空目录。
3. **重新探测模型名**（因为前缀可能变），页面跟着更新。
4. 告诉你「CPA 现在是停着的」——它不会替你重启。

不想开页面也可以命令行：

```bash
npm run check:updates                  # 只看
node tools/cpa-update.mjs --apply      # 真换（先把 CPA 停掉）
```

### 出问题时先看「连通状态」

页面第二块是三条独立探针，红绿一眼可见：

| 探针 | 它回答什么 |
| --- | --- |
| **模型调用（数据面）** | 客户端现在调模型能不能成。它拿上游 key 真打一次 `/v1/models` |
| **账号管理（管理面）** | 账号列表、登录、改账号开关能不能用 |
| **公网隧道** | cloudflared 进程活着没有、公网地址是什么；点「测公网」会真的绕公网回连一次 |

每把 key 那行还会显示「上次调用成功/失败 + 状态码 + 耗时 + 落在哪个号」，
以及当前是否已被日额度拦住（额度满了会直接说，不会假装正常）。

### 发出第一个请求

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
- 上游本体与插件：`runtime/`（安装器下载的，不入库，删掉即卸载上游）。
- 账号登录态：由 CPA 保存在 `~/.cli-proxy-api/`，BuddyKey 不复制。
  注意这是**固定路径**，装在 `runtime/` 的那份 CPA 也读它 —— 所以同机多份 CPA 共用账号。
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
- **插件的前缀会随版本变**（`wb/` ↔ `cn/`），所以模型名默认启动时探测。
  若 CPA 那时还没起，会先按兜底名跑并在 `/healthz` 标 `modelSource: "fallback"`；
  上游起来后重启一次即可。

## 文档

- 设计与防错清单 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 搬到服务器（systemd / nginx / 安全组）→ [docs/DEPLOY-SERVER.md](docs/DEPLOY-SERVER.md)
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
npm run check               # 全部 .mjs 的语法自检
npm run check:docs          # 文档相对链接 + 换行约定
```

## License

[MIT](LICENSE) —— 随便用、随便改、随便分发，出事不担责。

## 贡献

发现问题或想改动就开 issue / PR。
**提交前请务必确认没有把 `data/`、`runtime/`、`~/.cli-proxy-api/` 里的东西加进来** ——
那里是你的 API key、管理口令和账号登录态，一旦进了 git 历史就撤不回来。

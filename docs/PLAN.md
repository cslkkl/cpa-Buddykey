# BuddyKey 交接与后续计划

> 这份文档给「换一个工作区继续做」的人（或未来的自己）看。
> 结论先行：**A 节验收、B 节 UI 重做、C 节发布、E 节「别人拉下来能用」都已完成。**
> 剩下的只有一个可延后的 `dsh-cpa-switch` 搬迁。

## 一、当前进度

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 项目从桌面根目录独立成 `Desktop\BuddyKey` | 完成 | 目录存在，`data/` 与 `bin/` 已分家 |
| 登录 WorkBuddy 账号 → 自动入池 | 完成 | `POST /admin/api/login` 返回腾讯授权地址；`/admin/api/accounts` 见 8 个号 |
| 具名 API Key（名称 / Tracking ID / 遮罩 / 时间） | 完成 | `GET /admin/api/state` 的 `keys[]` |
| 按 key 记账（token / 积分 / 落在哪个号 / 客户端 IP） | 完成 | `data/usage.jsonl` 每行含 `account`、`clientIp` |
| 只放行一个模型 | 完成 | 其它模型回 404 `model_not_found` |
| 公网隧道（手机可用） | 完成 | `start-tunnel.cmd`；实测 `https://…trycloudflare.com/v1` 200 |
| 日额度上限（超限 429） | **已验收** | 见下 A 节 |
| 按 key 限定账号 | **已验收** | 见下 A 节 |
| UI 重做（Apple 极简） | **已完成** | `lib/ui.mjs`，见下 B 节 |
| 建 GitHub 仓库并推送 | **已完成** | `cslkkl/cpa-Buddykey`（private） |
| 文档网络（README / AGENTS / ARCHITECTURE / notes） | 完成 | `AGENTS.md` 已补验证快照与活跃坑 |
| **别人 clone 下来能配好并发出请求** | **已完成** | 见下 E 节 |

验收环境：`server.mjs` + `lib/` 复制到 `%TEMP%` 下的隔离副本，端口 8399（UI 用 8398），
`data/config.json` 只改端口。这样真实 `data/` 里的 key 明文与账本一行都没被测试写脏。

## 二、待办

### A. 验收两项新功能 —— 已完成（2026-11-12）

- [x] 重启服务，确认启动无报错、`/healthz` 正常。
      证据：`{"ok":true,…,"upstreamKey":"ok","adminKey":"ok"}`。
- [x] 建一把 key，设 `requestsPerDay: 2`，连发 3 次：第 1、2 次 200，第 3 次 429，
      且响应头有 `Retry-After`、错误码是 `daily_quota_exceeded`。
      证据：`retry-after: 19112`、`code: daily_quota_exceeded`、`param: requestsPerDay`。
- [x] 确认 429 **不消耗**上游额度：`data/usage.jsonl` 不该新增第 3 行。
      证据：3 次请求账本只增 2 行（`USAGE_DELTA=2`）。
- [x] 重启进程后再连发一次，仍是 429（验证「启动时回放当日账本」生效）。
      证据：同一 token 立即 429，账本增 0 行（`USAGE_DELTA=0`）。
- [x] 建一把 key，`scope.mode = "selected"`，只勾 2 个号，连发 6 次：
      每次 `X-Cpa-Trace-Id` 中间那段都落在这 2 个号里。
      证据：落号次数 4 / 2，范围外 0 次。
- [x] 请求结束后确认 CPA 的启用集合**已还原**（`/v0/management/auth-files` 里
      其余号回到 `disabled: false`）。
      证据：218ms 内采样 163 次，窗口内最小值 2（被截窄）、最大值 8（已还原）；
      直读 CPA `auth-files` 8 个全 `disabled:false`。
- [x] 边界：`selected` 但账号列表为空 → 按「全部账号」处理，不得永久 429。
      证据：创建时存成 `{mode:"all"}`；PATCH 传 `selected+[]` 也回落 `all`；
      随后的请求第 1 次 200（不是永久 429），第 2 次才因 `requestsPerDay:1` 正常 429。

⚠️ 验收中发现一个**真实存在的时序窗口**，已写进
[ARCHITECTURE.md](ARCHITECTURE.md) 与 [AGENTS.md](../AGENTS.md) 的活跃坑：
`forwardToUpstream()` 内已经 `response.end()`，`finally` 里才逐个 PATCH 还原，
所以客户端拿到 200 的瞬间 CPA 启用集合还是截窄的，约 100ms 后才回到全池。
同进程并发被 `withScopeLock` 挡住，但本机其它直连 CPA 的客户端会看到这个窗口。

### B. UI 重做（Apple 极简）—— 已完成

- [x] 新建 `lib/ui.mjs`，`export const PAGE`，保留 `__LAN_HINT__` / `__MODELS__` 两个占位符。
- [x] `server.mjs` 改成 `import { PAGE } from './lib/ui.mjs'`，删掉内联 `PAGE`
      （diff 严格为 4 行新增 + 272 行删除，后端逻辑一行未动）。
- [x] 设计口径：系统字体栈；**只用一个强调色** `#0071e3`（暗色 `#0a84ff`）；
      背景 `#fbfbfd`、卡片 `#fff`、hairline `#e8e8ed`、主文字 `#1d1d1f`、次要 `#86868b`；
      卡片圆角 18px、按钮全圆角；表格无竖线。
- [x] 深色模式：`@media (prefers-color-scheme: dark)` 全套换色。
- [x] 分段控件切换 `API Keys` / `账号`；窄屏表格改卡片堆叠，不横向溢出。
- [x] 创建 / 编辑弹层：名称、每日请求上限、每日积分上限、账号范围（全部 / 指定 + 多选）。
- [x] 明文 key 只展示一次 + 复制按钮（`navigator.clipboard` 失败时 `execCommand` 兜底）。
- [x] 错误就地展示（红字 `#ff3b30`），不用 `alert`；所有按钮点击期间禁用防重复提交。
- [x] 全部用户输入走 `textContent` 或自写转义，禁止直接拼进 `innerHTML`
      （实测 `lib/ui.mjs` 里 `innerHTML` 出现 0 次）。

### C. 发布 —— 已完成

- [x] `git init`，`.gitignore` 生效（`data/`、`bin/`、`*.log` 不入库）。
- [x] 分批原子提交（实际顺序，与最初设想略有调整，见下）：
  1. `chore: 项目骨架与启动脚本`
  2. `chore: 统一换行策略（源码 LF，bat/cmd CRLF）`
  3. `docs: 架构说明与两条关键决策记录`
  4. `feat(core): 具名 key、日额度、账号范围、单模型转发`（此时管理页仍是内联旧页）
  5. `feat(ui): 管理页拆出 lib/ui.mjs，改为 Apple 极简风`
  6. `docs: AGENTS 维护索引、验证快照与 PLAN 勾选`
- [x] `gh repo create cpa-Buddykey --private --source=. --push`。
- [x] 推送后核对 GitHub 上没有 `data/`、没有 `bin/cloudflared.exe`。
      证据：远端 `git/trees/main?recursive=1` 里 `data/*` 0 个、`bin/*` 0 个、`*.log` 0 个。

> **push 失败的坑（已记进 AGENTS.md 活跃坑）**：本机全局配了
> `http.https://github.com/.proxy=socks5h://127.0.0.1:7897`，但那个端口当时没有进程在听。
> `github.com:443` 的 TCP 能连、TLS 握手被阻断 → `git push` 超时；
> 而 `api.github.com:443` 是通的，所以 `gh repo view` / `gh api` 全绿，
> 只有 push 失败，极易误判成 token 权限问题。
> 解法：remote 改走 SSH 的 443 口，并且必须显式 `-o ProxyCommand=none`
> （否则 `~/.ssh/config` 那条 `connect -S 127.0.0.1:7897` 会把连接再丢给不存在的代理）。

> 关于第 4/5 条为什么没拆成 `core` / `quota` / `scope` 三个提交：
> `server.mjs` 是单个文件，`quota` 依赖 `dayUsage`、`scope` 依赖 `cpaAdmin`，
> 拆出的中间态根本编译不过。与其造假的中间版本，不如让 `feat(core)` 一次讲清三项功能，
> 把「拆页 + 重做视觉」单独成一个可回滚的提交。

### D. 收尾

- [x] 补 `AGENTS.md`（仪表盘：命令、验证快照、待办、活跃坑、文档地图）。
- [x] 跑链接校验：`python <skill>/check-markdown-links.py <项目> --fragments --refs`。
- [x] 跑换行校验：`python <skill>/check-line-endings.py <项目> --target lf`。

> 那套 python 脚本属于 `maintenance-flow` 技能，本机当前没有该技能目录。
> 改为在项目内落了一个等价的自检脚本 `tools/check-docs.ps1`（`npm run check:docs`）：
> 递归扫所有 `.md` 的相对链接目标、以及「源码 LF / `.cmd`·`.bat` CRLF」的换行约定。
> 当前结果：0 个失效链接、换行全部符合约定。
> 顺带修掉两个真问题：`start.cmd` / `start-tunnel.cmd` 是 LF（cmd.exe 依赖 CRLF）、
> `package.json` 被 PowerShell 写成了 CRLF。

### E. 「别人拉下来能不能用」—— 已完成（2026-11-12）

目标原话：*检查现在是不是别人拉取这个项目就可以登录然后获取 api 了，一直到达到这个功能。*

**结论：原来不能，现在能了。** 原来唯一断点是「两个 CPA 密钥没有地方可配」——
`readCredentialRefs()` 只读 `~/.dsh/.credentials.yaml`，那是作者这台机器上
dsh-cpa-switch 生成的，别人 clone 下来必然读不到，于是账号列表 `no-admin-key`、
登录 `CPA 401`、调模型 `upstreamKey missing`。

改了三处：

- [x] **凭据三级来源**：`config.json` 直写 > `BUDDYKEY_UPSTREAM_KEY` / `BUDDYKEY_ADMIN_KEY`
      环境变量 > `~/.dsh/.credentials.yaml` 的 refs（旧路径，保持兼容）。
      `/healthz` 与 `/admin/api/state` 都会报 `upstreamKeyFrom` / `adminKeyFrom`
      （`config` / `env` / `refs` / `none`），「配了没生效」和「压根没配」能一眼分开。
- [x] **`npm run setup`**（`tools/setup.mjs`）：一问一答写 `data/config.json`（先备份），
      上游 key 自动从 CPA 的 `access.api-keys` 嗅探，管理密钥让用户粘明文，
      写完立刻校验一次并说明结果。也支持全参数非交互模式。
- [x] **管理页首次上手引导**：`/admin/api/state` 多了 `setup` 段；
      页面在「密钥没配全 / 池子里没号」时显示「还差一步就能用」卡片，
      逐条列出缺什么、当前来源、该填哪个字段、配置文件绝对路径、可用的环境变量名。
      配好或登录过就自动收起。

顺手修掉两个真 bug：

- [x] **`readPool()` 不检查 HTTP 状态码**：CPA 失败时回 `{error: "..."}`，
      `accountsBody?.accounts ?? []` 得到 `[]`，于是返回 `ok:true, accountCount:0` ——
      页面显示「池子是空的」而不是「读不到」。封禁 / 密钥错误时会误导用户以为号没了。
- [x] **CPA 的 IP 封禁没有翻译**：连续输错管理密钥会触发
      `403 {"error":"IP banned due to too many failed attempts. Try again in 29m41s"}`，
      原始 JSON 丢给用户看起来就像程序坏了。现在统一翻译成能照做的中文并带剩余时间。

**验证证据**（隔离副本 + 独立 HOME，端口 8354）：

| 场景 | 结果 |
| --- | --- |
| 三级来源 A：全不配 | `upstreamKey=missing from=none` / `adminKey=missing from=none` |
| 三级来源 B：`config.json` 直写 | 两个都是 `from=config` |
| 三级来源 C：环境变量 | 两个都是 `from=env` |
| 三级来源 D：config + env 混合 | `upstreamKey from=config`、`adminKey from=env`（优先级正确） |
| 陌生人 clone → 建 key | `ok:true`，返回 `sk-pool-…` |
| 陌生人 clone → 调模型 | **HTTP 200**，落号 `e9252b1d9ddc2b36`，`usage.jsonl` 增加 1 行 |
| `/v1/models` | 返回两个别名 `deepseek-v4.1` / `deepseek-v4.1-flash` |
| 不支持的模型 | 404 `model_not_found` |
| 空 HOME + 空密钥 → 引导卡片 | 显示「缺 上游 API key、管理密钥」+ 三条步骤 + 配置文件绝对路径 |
| 封禁期间读池子 | `ok:false` + 「CPA 把这个 IP 临时封了……还剩约 26m」 |

**还没验到的**（受 CPA 的 IP 封禁限制，封禁是本次测试自己打出来的，约 30 分钟）：

- 「配好密钥后，引导卡片收起」这条 —— 需要管理面恢复后才能验。
- 陌生人走完「登录 WorkBuddy 账号 → 账号进池 → 建 key → 调用」的完整链路。
  其中「建 key → 调用」已单独验过（见上表），只差登录那一段。

### E2. 用打桩上游把剩下的分支补验 —— 已完成（2026-11-12）

真 CPA 被封着，就用 `tools/fake-cpa.mjs`（`npm run fake-cpa`，默认 8390）
起一个形状对齐的假上游，把「密钥配好之后」的行为全验了一遍。它同时是个长期资产：
以后测「密钥错误」「上游报错」「IP 封禁」都不用碰真账号池。

| 场景 | 结果 |
| --- | --- |
| 账号列表（密钥正确） | `ok:true`，2 个号，`summary` 合计 remain 2000 / used 500 |
| `state.setup` 密钥齐全 | `upstreamKey=ok/config`、`adminKey=ok/config` |
| 引导卡片 | **已收起**（`setupCard.hidden === true`），池子显示 2,000、账号数 2 |
| 登录流程 | 起授权 URL 正常、`status=done` 能收尾 |
| 账号开关 | 停用后 `enabled=1` 且该行 `disabled=true`；恢复后 `enabled=2` |
| 范围 + 日额度联合 | `selected` 只勾一个号连发 4 次：前 2 次 200 且落号一致，第 3、4 次 429（`requestsPerDay:3` 已达上限） |
| 429 响应 | `retry-after: 13616`、`code: daily_quota_exceeded` |
| 范围还原 | 请求后 `enabled` 回到 2 |
| 管理密钥错误 | 「管理密钥不对（CPA 回 invalid management key）。adminKey 要 management.secret-key 的明文，不是那个 bcrypt 哈希。」 |
| 连续错密钥 → 封禁 | 升级成「CPA 把这个 IP 临时封了……还剩约 1m0s。等它到期即可，别继续重试」 |
| `npm run setup` 密钥正确 | `✓ 管理密钥有效，CPA 里读到 2 个凭据文件。`，exit 0 |
| `npm run setup` 密钥错误 | `⚠️ 上游回 HTTP 401 —— 管理密钥大概率不对`，exit 2 |

**做桩时踩到的两个坑**（已写进代码注释）：

1. `disabled` 只能存在 `FILES` 里、`/accounts` 的响应现算 —— 真 CPA 就是这样。
   桩里各存一份会出现「auth-files 已停用、accounts 还说启用中」的假象，
   把被测代码的正常行为误判成 bug（第一版桩就错了，白查一轮）。
2. `readPool()` 与 `listAccounts()` 读的字段不同：前者只用 `/plugins/<channel>/accounts`
   与 `/credits`，后者还多读 `/auth-files` 拿文件名。桩这三条都要对上。

### E3. 生产服务已切新代码

`127.0.0.1:8318` 已重启（旧 pid 30388 → 新 pid 17024），实测：

- `/healthz` 多了 `upstreamKeyFrom: "refs"` / `adminKeyFrom: "refs"`（本机走的是旧路径，符合预期）；
- `/admin/api/state` 有完整 `setup` 段；
- 封禁期间 `pool` 正确回 `ok:false` + 「还剩约 18m29s」而不是假装空池；
- 用真实 key 调 `deepseek-v4.1` 仍然 **200**，落号 `0f4f3a929bd81dc3` —— 数据面不受管理面封禁影响。

> ⚠️ 复现这段测试时注意：CPA 对 `/v0/management/*` 有 IP 级失败计数，
> 用假管理密钥测试会把这台机器封 30 分钟，且每次重试都重新计时。
> 要测「密钥错误」的分支，用 `npm run fake-cpa` 打桩，别对真 CPA 试。

### E4. 解封后在真机走完整链路 —— 已完成（2026-11-12 20:34）

CPA 的 IP 封禁到期后，在**真实 CPA + 真实账号池**上把整条链路走了一遍：

| 场景 | 结果 |
| --- | --- |
| 生产服务读账号 | `ok:true`，8 个号全 `disabled:false`，remain 30429 |
| `state.pool` | 恢复 `ok:true, accountCount:8` |
| 真机登录流程 | `POST /admin/api/login` 返回腾讯授权地址（`https://copilot.tencent.com/login?platform=CLI&state=…`），`status=wait` 后取消会话，没真授权 |
| 建 key（范围 + 限额） | `selected` 勾 2 个号、`requestsPerDay:2` |
| 连发 3 次 | `200`（落 `0f4f3a929bd81dc3`）/ `200`（落 `45ae2dfed4479b92`）/ `429` —— 全部落在指定范围内 |
| 429 不写账 | 账本增量 **2**（不是 3） |
| 范围还原 | 请求后 `enabled` 回到 8 |
| 清理 | 删掉这把验收 key，回到原有 2 把 |
| **`npm run setup` 真机全流程** | 自动嗅探到 `sk-cpa-local-2026`、粘管理密钥后 `✓ 读到 16 个凭据文件`、exit 0 |
| 用 setup 产物起服务 | `/healthz` 报 `upstreamKeyFrom: "config"` / `adminKeyFrom: "config"` |
| 用 setup 产物建 key + 调用 | 建 key `ok:true`，调 `deepseek-v4.1` **200**，落号 `47c82c4c8415a897` |

**结论：这条目标达成了。** 一个「已装好 CPA、已登录 WorkBuddy 账号、知道两个密钥」
的人，clone → `npm run setup`（两分钟内）→ `npm start` → 打开页面 →
登录/建 key → 发出第一个请求，全程不需要改代码、不需要作者这台机器的任何东西。

### E5. 页面上显示「打通了没有」—— 已完成（2026-11-12 20:46）

目标原话的后半句：*apikey 是否打通、隧道能否正常使用也要显示在上面。*

新增「连通状态」卡片，三条彼此独立、红绿一眼可见：

| 探针 | 怎么测 | 失败时说什么 |
| --- | --- | --- |
| 模型调用（数据面） | 拿 `upstreamKey` 真打 `/v1/models` | 连不上显示上游地址与原因；回非 200 说「密钥可能不对」 |
| 账号管理（管理面） | 拿 `adminKey` 打 `auth-files` | 复用 `explainUpstreamError`：缺密钥 / 密钥错 / IP 封禁 + 剩余时间 |
| 公网隧道 | 读 `tunnel.log` 拿地址 + metrics 端口 + connector id，探 `/ready` | 未运行就明确说「手机在外面用不了，本机与同一 Wi-Fi 不受影响」 |

「公网是否真的可达」做成**点了才测**（`POST /admin/api/health/tunnel`）：
从本机 fetch 自己的 trycloudflare 地址要绕一圈公网，不该进自动轮询。

每把 key 那行补了「上次调用成功/失败 + 状态码 + 耗时 + 落号」，以及 `blocked`
（当前会不会被额度闸门拦）。后者是必需的：429 不写账本，被限流的 key 的 `lastCall`
会停在成功那次，光看它会得出「一切正常」的错误结论。

**实测证据**（8318 生产 + 真 cloudflared 隧道）：

| 场景 | 结果 |
| --- | --- |
| 数据面 | `ok:true`，HTTP 200，3ms |
| 管理面 | `ok:true`，60ms |
| 隧道未启动 | `running:false`、`fetch failed`、红点、页脚提示手机用不了 |
| 隧道运行中 | `running:true`、connector 匹配、`readyConnections:1` |
| 点「测公网」 | **200**、2336ms、回连 `healthz` 两个 key 都 ok、页脚变「三条都通：本机、局域网、公网都能用」 |
| 停隧道后 | 立刻回 `running:false` |
| 每把 key | `上次调用成功 200 · 899ms · 落号 0f4f3a92`；没调过显示「还没用过」 |

**过程中挖出的一个真 bug**：`cloudflared` 的 metrics 端口（默认 20241）是**全局**的。
第一版只探「端口有没有响应」，结果我起了一条测试隧道，生产页面立刻误报「运行中」，
还显示早就失效的旧域名。改成拿日志里的 `Generated Connector ID` 与 `/ready` 返回的
`connectorId` 比对，不一致判 `connector-mismatch` —— 现在这种串台会被明确识别出来。

### F. 把上游也装进来 —— 已完成（2026-11-13）

目标原话：*这些前提能不能都整合到这个项目里面……别人拉取的时候自动会帮别人搞定一切，
除了要自己登录账号。*

**原来做不到，现在做到了。** 三条前提里：

| 前提 | 原来 | 现在 |
| --- | --- | --- |
| CPA 本体在跑 | 自己想办法装 | `npm run install-cpa` 自动下载 |
| workbuddy 插件已装 | 自己找（原仓库还 404 了） | 从官方插件商店下载 |
| 已登录至少一个账号 | 自己登 | **仍需你自己扫码** —— 授权只能人做 |

#### 关键发现：官方插件商店

原文档里记着「插件源仓库 `mmqz/cpa-multi-plugins` 现在 404」。这次找到了正源：
`router-for-me/CLIProxyAPI-Plugins-Store` 的 `registry.json`（181 个插件），
其中 `id: workbuddy` 条目指向 `zidanefaqih/codebuddy-intl-cpa`，
release 提供 6 个平台的 zip，带 `checksums.txt` 与 API 侧 `digest`。

CPA 本体则在 `router-for-me/CLIProxyAPI` 的 release（`v8.0.69`，
`CLIProxyAPI_8.0.69_windows_amd64.zip`）。

#### 实现

- `tools/install-cpa.mjs`（`npm run install-cpa`）：探测 → 下载 → 解压 → 生成配置 → 写 BuddyKey 配置。
  - **探测优先**：本机已有 CPA（`~/.dsh/cpa-panel/runtime/cpa` 或 `~/.cli-proxy-api`）就默认复用、
    不覆盖。要强制装新的一套得显式 `--download`。
  - **每次都校验 sha256**，对不上不落盘。
  - 交互与非交互（`--port` / `--api-key` / `--secret-key` / `--yes`）两种模式。
  - 生成的 `config.yaml` 只开 workbuddy 一个渠道，不抄 85 KB 的 example。
- `tools/run-cpa.mjs`（`npm run cpa`）：以 CPA 自己的目录为 cwd 启动，转发日志，Ctrl+C 转给子进程。
- `tools/zip.mjs`：零依赖 zip 解压（stored + deflate），因为项目不引 npm 包而 Node 没有内置解压。

#### 挖出的关键问题：插件前缀变了

装完第一次调用就 400 `unknown provider for model wb/deepseek-v4.1-flash`。查下来：

| 插件版本 | 暴露的模型 id |
| --- | --- |
| `workbuddy.dll` v0.9.89（本机旧版，腾讯 CN） | `wb/deepseek-v4.1-flash` |
| CodeBuddy Intl CPA v0.10.0（商店新版） | `cn/deepseek-v4.1-flash` |

模型名写死会导致「装完什么都对、一调就 400」，而报错指向 model 不指向插件版本，极难查。
已改成**启动时探测**：`await probeModelCatalog()` 问一次 CPA `/v1/models`，
按候选优先级挑真实存在的那个，同时接受短别名。
`/healthz` 的 `modelSource` 报 `probe` / `config` / `fallback`。

#### 验证证据

从零（隔离副本，无 `runtime/`）跑 `--download`：

| 步骤 | 结果 |
| --- | --- |
| CPA release | `v8.0.69`（2026-11-12） |
| 下 CPA zip | 24.8 MB，sha256 ✓ |
| 解出 exe | `runtime/cpa/cli-proxy-api.exe`，75 MB |
| 插件商店 | `workbuddy` = CodeBuddy Intl CPA `v0.10.0`（zidanefaqih） |
| 下插件 zip | 3.2 MB，sha256 ✓ |
| 解出插件 | `runtime/cpa/plugins/workbuddy.dll`，8 MB |
| 生成 config | port / api-keys / secret-key 齐全 |
| `npm run cpa` | `API server started successfully on 127.0.0.1:8320`，插件注册 v0.10.0 |
| 数据面 / 管理面 | 200 / 200，账号列表 `count=8` |
| 登录 | 拿到 `codebuddy.ai` 授权地址，`status=wait` |
| BuddyKey 连它 | `modelSource: "probe"` → `cn/deepseek-v4.1-flash` |
| 建 key + 调用 | 200，短名 `deepseek-v4.1-flash` 也能用 |

生产环境（旧版插件）也验了探测：`modelSource: "probe"` → `wb/deepseek-v4.1-flash`，
启动日志打印「兜底猜的 cn/… 不存在，实际用探测到的」，调用 200 落号 `0f4f3a929bd81dc3`。

#### 顺带修的两个 bug

- **`fetch` 的 `ECONNREFUSED` 在 `error.cause.code` 里**，不在 `message`（message 只是 `fetch failed`）。
  按 message 判断会把「端口没人听」误判成「被占用」，于是明明能起却拒绝启动。
- **`Start-Process -Environment` 带 USERPROFILE 会让 job runner 崩**（本机现象），
  模拟空 HOME 要用 `cmd /c "set USERPROFILE=…"` 包装。

### G. 插件版本可见、可点、可回退 —— 已完成（2026-11-13）

参照 `dsh-cpa-switch` 的 `ops/plugin-update.ts` 与它的决策记录
（`2026-10-12-plugin-update-path.md`）实现。

#### 那边原来踩过的坑，本项目当时也具备同样条件

`dsh-cpa-switch` 的 `prepare()` 跳过判据是「exe 存在 / dll 数 > 0」，
于是渠道插件**永远不会更新** —— 本机实测停在上游修 bug 之前的版本，
而那个 bug 是「整轮对话 500」。而代码注释写着「需要用户显式点重装」，
那个入口从来不存在。

**BuddyKey 的 `install-cpa` 当时是同一种形状**：`if (sourcePresent(...)) 跳过`，
且 `install.json` 只记 `mode / port / keys`，**不记 tag** —— 所以连「装的是哪版」都不知道。

#### 照搬的四条决策

| 决策 | 理由（来自那边的记录，本项目同样成立） |
| --- | --- |
| **不给自动更新** | 上游随时改行为（模型目录 / 请求形状 / 签到协议都改过），静默升级等于把上游风险灌给用户 |
| **判据是 tag 相等**，不解析 semver | 零解析、零边界；两个 tag 都显示，谁新谁旧由人看 |
| **记录「装的是哪个 tag」** | 没有它就无法回答「旧不旧」；老机器没有记录时**如实说未知** |
| **停 → 换 → 报告，不自动重启** | 替用户决定「重启」与「不越权」的口径相反 |

明确没采用的：靠比对 asset 的 sha256 判有没有新版（`digest` 在旧 release 上可能为空；
上游重打包不 bump 时误报）；自动重启 CPA。

#### 三句不许含糊的话（有对应断言）

1. **没记录 ≠ 有新版** —— 编 `true` 会催用户换一份可能已经最新的东西，编 `false` 把真话说反。
2. **查不到上游 ≠ 已是最新** —— 断网 / 限流是一句失败，不是「没有新版」。
3. **认不出响应就不说话** —— 返回空行不渲染，不印「已是最新」替后端撒谎。

#### 实现分层（与那边同构）

| 本项目的文件 | 对应那边 | 职责 |
| --- | --- | --- |
| `lib/update-text.mjs` | `client/update-text.ts` | **纯判据**：吃响应、吐一行话 + 一个动作。无 I/O，可直接测 |
| `tools/upstream.mjs` | `setup/download.ts` + `setup/install.ts` | 查 / 下 / 校验 / 备份 / 解压 / 记 tag；`force` 是参数 |
| `tools/cpa-update.mjs` | —（本项目补的命令行） | `--check` / `--apply` |
| `server.mjs` 的 `/admin/api/updates` | `ops/plugin-update.ts` + 路由 | GET 查、POST 换；**换完重探模型** |
| `lib/ui.mjs` 的更新行 | `Panel.tsx` + `updateView` | 那一行 + 按钮 |
| `tools/check-ui.mjs` | （那边靠 TS 类型） | 守模板字符串纪律 |

`install-cpa.mjs` 现在只是交互外壳，下载流水线全部委托 `tools/upstream.mjs` ——
这样「首次安装」与「强制更新」走**同一份**代码。那边的记录写死了这条：
强制更新若在外面重写一遍，**第一件被漏掉的通常就是 sha256 校验**。

#### 本项目比那边多的两件事

1. **更新前必须确认 CPA 停着**：`dsh-cpa-switch` 自己管 CPA 进程，能 `runtime.stop()`；
   BuddyKey 不是 CPA 的父进程，**停不掉也不该杀**别人的进程。
   所以只在探测到上游可达时**拒绝**并给出具体指令。
   判据用 `reached` 而不是 `ok` —— 回 401 也说明进程活着、dll 被占用。
2. **更新完必须重探模型目录**：这是本项目独有的耦合 —— 插件换版本时模型前缀会变
   （`wb/` ↔ `cn/` 已实测）。漏掉会得到「更新成功但每个请求都 400 unknown provider」，
   而报错指向 model，完全看不出跟刚才那个更新有关。

#### 验证证据（隔离副本 8377 + `fake-cpa`）

| 场景 | 结果 |
| --- | --- |
| 没记过 tag | `installed: null`，页面「已装版本未知…」+「更新」 |
| 记录与上游一致 | `hasUpdate: false`，页面「已是 v0.10.0，与上游一致」，无按钮 |
| 记录旧于上游 | `hasUpdate: true`，页面 `v0.9.9 → v0.10.0` +「更新」 |
| 查不到上游 | `ok:false, reason: release-query-failed` +「重试」 |
| 不认识的 `?key=` | 400 `unknown-source` |
| **CPA 在跑时更新** | **409 拒绝**，磁盘 0 字节改动（`plugins/` 目录都没建） |
| CPA 停着时更新 | **200**，7s 完成，`verified:true`，`stopped:true`，落盘 7.57 MB |
| 更新后 | `install.json` 记 `tag: v0.10.0`；再查变「已是最新」 |
| 更新后重探模型 | 响应带 `model` / `modelSource` / `models` |
| `npm run check` | 8 个文件语法 + UI 结构断言 + 判据六态，全过 |

#### 顺带修的两处

- **`node --check` 抓不住模板字符串被截断**：注释里两个反引号恰好配对时语法照样成立，
  页面却断成半截。新增 `tools/check-ui.mjs` 直接断言 PAGE 首尾、占位符次数、结构锚点。
- **注入脚本必须包在 `<script>` 里**：`__UPDATE_TEXT__` 一开始放在标签外，
  浏览器报 `updateView is not defined` 而服务端一切正常 —— 这类问题只有开页面看控制台才能发现。

## 三、另一个项目的搬迁（未完成，可延后）

`dsh-cpa-switch` 仍在 `Desktop\dsh-cpa-switch`，目标位置是 `Desktop\Projects\dsh-cpa-switch`。

- 它是 DSH 插件的源码仓库，`~/.dsh/profiles/web/node_modules/dsh-cpa-switch`
  是一个 **junction** 指回它。
- 直接搬会被占用（DSH 正在加载它，且会话工作目录就在里面）。上次尝试的教训：
  `robocopy /MOVE` 被占用时会**部分回滚**，源目录还在、目标目录消失，看起来像丢了文件。
- 正确顺序：确认没有进程 cwd 在该目录 → 移动 → 重建 junction → 重启 DSH → 验证插件的
  `lib/index.js` 能被加载。
- 搬迁前先看 `AGENTS.md`（仓库根）的「活跃坑」：profile 里那个包**必须是 junction**，
  否则改源码不生效。

## 四、边界与已知限制（不要把这几条当 bug）

1. **账号范围是全局切换实现的**：CPA 的 `access.api-keys` 是裸字符串列表，
   路由只有 `round-robin` / `fill-first` / 权重排除，没有 per-key credential binding。
   所以范围请求串行执行，切换窗口内其它客户端会看到启用集合被短暂改动。
   替代方案与取舍见 [决策记录](../.agents/notes/2026-11-12-account-scope-via-toggle.md)。
2. **还原发生在响应之后**：客户端拿到 200 时 CPA 启用集合还没还原，约 100ms 后才回到全池。
   同进程并发被锁挡住，本机其它直连 CPA 的客户端会看到这个窗口。详见
   [ARCHITECTURE.md](ARCHITECTURE.md) 的「还原的真实时序」。
3. **隧道是临时的**：`trycloudflare.com` 随机子域，重启即换；公开域名可解析，
   只靠 `sk-pool-` 这把 key 拦人。
4. **电脑关机即断**：整条链路（cpa-pool → CPA → 上游）三环里两环在本机，
   账号登录态也在本机磁盘上。
5. **渠道插件只有 Windows 版**（`workbuddy.dll`），换 Linux 服务器跑不起来；
   Linux 版 CPA 二进制里搜不到 `workbuddy`，渠道只能由插件提供。
6. **CPA 插件源仓库 `mmqz/cpa-multi-plugins` 现在 404**：面板的「更新」按钮会失败，
   但已装的 dll 正常工作，不影响使用。
7. **`X-Cpa-Trace-Id` 只在 200 上有**：CPA 的 4xx 不带这个头，所以失败请求的
   `account` 记账字段恒为空，别当成调度异常。
8. **`/favicon.ico` 落进转发层**：被当成 OpenAI 请求拦下回 401，浏览器控制台有一条红字，
   不影响功能。想消掉就在路由里加一条空 204。

## 五、关键路径速查

| 东西 | 路径 |
| --- | --- |
| 本服务 | `Desktop\BuddyKey` |
| 入口 | `server.mjs`（HTTP + 转发 + 额度 + 范围 + 模型探测） |
| 管理页 | `lib/ui.mjs`（`export const PAGE`，Apple 极简风） |
| 运行时数据 | `data/keys.json`、`data/usage.jsonl`、`data/config.json` |
| **上游安装器** | `tools/install-cpa.mjs`（`npm run install-cpa`） |
| **上游启动器** | `tools/run-cpa.mjs`（`npm run cpa`） |
| **自带上游** | `runtime/cpa/`（exe + plugins/ + config.yaml + install.json） |
| 文档自检 | `tools/check-docs.ps1`（`npm run check:docs`） |
| 隧道二进制 | `bin/cloudflared.exe` |
| 自建 CPA（若没跑安装器） | `runtime/cpa/cli-proxy-api.exe` |
| 复用别处的 CPA | `~/.dsh/cpa-panel/runtime/cpa/cli-proxy-api.exe`（端口 8317） |
| 账号登录态（固定路径） | `~/.cli-proxy-api/workbuddy-*.json` |
| 管理密钥（旧路径） | `~/.dsh/.credentials.yaml` 的 `CPA_API_KEY` / `CPA_ADMIN_KEY` |
| GitHub 仓库 | `cslkkl/cpa-Buddykey`（private） |

## 六、外部依赖清单（都是别人维护的，更新走各自 release）

| 依赖 | 来源 | 装到哪 |
| --- | --- | --- |
| CPA 本体 | `router-for-me/CLIProxyAPI` release | `runtime/cpa/cli-proxy-api.exe` |
| workbuddy 插件 | 插件商店 registry → `zidanefaqih/codebuddy-intl-cpa` release | `runtime/cpa/plugins/workbuddy.dll` |
| cloudflared | 需自己下（不入库） | `bin/cloudflared.exe` |

两个自动下载的都校验 sha256。**插件不是本项目维护的**，它的模型前缀、
接口行为都可能随后续版本变化 —— 这也是模型名要探测而不能写死的原因。

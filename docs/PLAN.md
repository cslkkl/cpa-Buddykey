# BuddyKey 交接与后续计划

> 这份文档给「换一个工作区继续做」的人（或未来的自己）看。
> 结论先行：**A 节验收已完成，B 节 UI 重做已完成，C 节发布已完成。**
> 剩下的只有 D 节收尾里还没跑的两条校验，以及一个可延后的搬迁。

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
| 入口 | `server.mjs`（HTTP + 转发 + 额度 + 范围） |
| 管理页 | `lib/ui.mjs`（`export const PAGE`，Apple 极简风） |
| 运行时数据 | `data/keys.json`、`data/usage.jsonl`、`data/config.json` |
| 文档自检 | `tools/check-docs.ps1`（`npm run check:docs`） |
| 隧道二进制 | `bin/cloudflared.exe` |
| CPA 本体 | `~/.dsh/cpa-panel/runtime/cpa/cli-proxy-api.exe`（端口 8317） |
| 账号登录态 | `~/.cli-proxy-api/workbuddy-*.json` |
| 管理密钥 | `~/.dsh/.credentials.yaml` 的 `CPA_API_KEY` / `CPA_ADMIN_KEY` |
| GitHub 仓库 | `cslkkl/cpa-Buddykey`（private） |

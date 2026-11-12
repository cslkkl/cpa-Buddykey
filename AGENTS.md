# BuddyKey — 维护索引

一次会话的入口：规则速查 + 常用命令 + 待办 + 活跃坑 + 文档地图。

## 全局规则

- **只放行一个模型**：`wb/deepseek-v4.1-flash`。其余返回 404，不改写。
- **管理密钥永不下发浏览器**：页面只调本服务 `/admin/api/*`。
- **key 明文只在本机**：`data/keys.json`；列表只暴露遮罩串。
- **范围还原必须在 `finally`**：漏了会让别的客户端看到被截窄的池子，且**无告警**。
- **零依赖**：不引 npm 包；`lib/` 只放纯计算与静态资源。
- **密钥来源三级**：`data/config.json` > 环境变量 > `~/.dsh/.credentials.yaml` 的 refs。
  改了顺序要同步 `/healthz` 的 `*From` 字段与管理页引导卡片。

## 常用命令

```bash
npm start                     # 启动（等价 node server.mjs）
npm run setup                 # 首次配置：一问一答写 data/config.json
npm run fake-cpa              # 起一个假 CPA（默认 8390），测密钥错误 / 封禁分支用
npm run check                 # 语法自检（server.mjs + lib/ui.mjs + 两个 tools）
npm run check:docs            # 文档相对链接 + 换行约定（tools/check-docs.ps1）
```

**测上游相关分支一律用 `npm run fake-cpa`，别拿真 CPA 试** —— 它有 IP 级失败封禁。

```bash
# 桩的管理密钥 / 上游 key 是固定值，直接配进一个隔离副本的 config.json 就能跑
node tools/fake-cpa.mjs 8390
# admin key: fake-admin-key    upstream key: fake-upstream-key
```

`npm run setup` 也支持全参数非交互模式，方便远程指导别人粘一段命令：

```bash
node tools/setup.mjs --upstream-key sk-cpa-… --admin-key … --port 8318 --yes
```

验收要在**隔离副本**里跑，别污染 `data/`：

```powershell
# 复制 server.mjs + lib/ 到临时目录，造一份改过端口的 data/config.json，
# 再 npm start 之外直接 node server.mjs，用 8399 之类的空端口跑。
# 这样真实 key 明文、真实账本一行都不会被测试写脏。
#
# 要模拟「别人刚 clone、什么都没配」：把 USERPROFILE / HOME 指到一个空目录。
# Start-Process 的 -Environment 带这两个变量在本机会让 job runner 报
# 「exit code 4294967295」，改用 cmd 包装：
#   cmd /c "set USERPROFILE=EMPTY&& set HOME=EMPTY&& cd /d REPO && node server.mjs > o.log 2> e.log"
```

## 验证快照

- 语法：`npm run check` 通过（`server.mjs` + `lib/ui.mjs`）；`npm run check:docs` 0 失效链接、换行合规。
- 真机：登录 / 账号列表 / 单模型放行 / 公网隧道调用 均已验过（2026-11-12）。
- **线上进程已换成新代码**（2026-11-12 20:15 重启，旧 pid 30388 → 新 pid 17024）：
  `/healthz` 多了 `upstreamKeyFrom: "refs"` / `adminKeyFrom: "refs"`（本机走旧路径，符合预期）；
  `/admin/api/state` 有完整 `setup` 段；封禁期间 `pool` 回 `ok:false` + 「还剩约 18m29s」
  而不是假装空池；用真实 key 调 `deepseek-v4.1` 仍 **200**，落号 `0f4f3a929bd81dc3`。
- **早先一次线上验证**（2026-11-12 18:57）：
  `/healthz` 200 `keys:2`，首页 43 KB、两个占位符无残留、含 `--hairline:#e8e8ed`（新 UI 生效），
  两把真实 key 的当日用量（12 次 / 2.21 积分、4 次 / 0 积分）经账本回放后一致。
- **日额度 + 账号范围：已验收**（2026-11-12，隔离副本 8399 + 真实 CPA 8317）：

  | 项 | 结论 | 关键证据 |
  | --- | --- | --- |
  | 重启后启动无报错、`/healthz` 200 | 通过 | `{"ok":true,…,"upstreamKey":"ok","adminKey":"ok"}` |
  | `requestsPerDay:2` 连发 3 次 | 通过 | `200 / 200 / 429` |
  | 429 带 `Retry-After` 与错误码 | 通过 | `retry-after: 19112`、`code: daily_quota_exceeded`、`param: requestsPerDay` |
  | 429 不消耗上游、不写账 | 通过 | 3 次请求 `usage.jsonl` 只增 2 行 |
  | 重启进程后当日额度仍生效 | 通过 | 同一 token 立即 429，账本增 0 行 |
  | `scope=selected` 只落指定号 | 通过 | 连发 6 次，落在 2 个号的次数分别为 4 / 2，范围外 0 次 |
  | 窗口内启用集合确实被截窄 | 通过 | 218ms 采样 163 次，启用数最小 2（全池 8） |
  | 请求后启用集合已还原 | 通过 | 采样最大值回到 8；直读 CPA `auth-files` 8 个全 `disabled:false` |
  | `selected` + 空账号列表 | 通过 | 存储层回落成 `{mode:"all"}`，首次请求 200，不是永久 429 |
  | 管理页 Apple 极简重做 | 通过 | 见下节「UI 验收」 |

- **UI 验收**（2026-11-12，隔离副本 8398，Playwright 实测）：
  - 首页 200、`__LAN_HINT__` / `__MODELS__` 无残留，局域网地址与模型别名已注入。
  - 亮色 `#fbfbfd` / `#1d1d1f` 生效；`prefers-color-scheme: dark` 全套变量存在。
  - 分段控件两个视图可切换；窄屏 469px 无横向溢出，表格 `display:block` 转卡片堆叠。
  - 创建弹层含名称 / 每日请求 / 每日积分 / 账号范围（全部·指定），指定时渲染 8 个账号 + 全选 / 清空。
  - 明文 key 只展示一次并带「复制」按钮（`navigator.clipboard` 失败时 `execCommand` 兜底）。
  - 错误就地展示（清空名称后弹层内出现「请先给这把 key 起个名字」），弹层不关闭，无 `alert`/`confirm`/`prompt`。

- **「别人拉下来能用」已验收**（2026-11-12，隔离副本 8354 + 空 HOME）：

  | 场景 | 结果 |
  | --- | --- |
  | 全不配 | `upstreamKey=missing from=none`、`adminKey=missing from=none` |
  | `config.json` 直写 | 两个都 `from=config` |
  | 环境变量 | 两个都 `from=env` |
  | config + env 混合 | `upstreamKey from=config`、`adminKey from=env`（优先级正确） |
  | clone → 建 key | `ok:true`，拿到 `sk-pool-…` |
  | clone → 调模型 | **HTTP 200**，落号 `e9252b1d9ddc2b36`，账本 +1 行 |
  | `/v1/models` | 两个别名；不支持的模型 404 `model_not_found` |
  | 空 HOME + 空密钥 | 管理页显示「还差一步就能用」三条步骤 + 配置文件绝对路径 |
  | CPA 封禁期间读池子 | `ok:false` + 「CPA 把这个 IP 临时封了……还剩约 26m」 |
  | `npm run setup` 交互 / 非交互 | 都能写 `data/config.json`；上游 key 从 CPA `access.api-keys` 自动嗅探成 `sk-cpa-local-2026` |

  未验（受 CPA 的 IP 封禁限制）：配好密钥后引导卡片是否收起；陌生人走完「登录 → 入池 → 建 key → 调用」整链。
  → 这两条已在下一节用打桩上游补验完毕。

- **用打桩上游补验了剩下的分支**（`npm run fake-cpa`，端口 8390 + 隔离副本）：

  | 场景 | 结果 |
  | --- | --- |
  | 账号列表（密钥正确） | `ok:true`，2 个号，remain 2000 / used 500 |
  | 引导卡片（密钥齐全） | **已收起**，池子 2,000、账号数 2 |
  | 登录流程 | 授权 URL 正常出、`status=done` 能收尾 |
  | 账号开关 | 停用后 `enabled=1` 且该行 `disabled=true`；恢复后 `enabled=2` |
  | 范围 + 日额度联合 | `selected` 勾一个号连发 4 次：前 2 次 200 落号一致，第 3、4 次 429 |
  | 429 响应 | `retry-after: 13616`、`code: daily_quota_exceeded` |
  | 范围还原 | 请求后 `enabled` 回到 2 |
  | 管理密钥错误 | 「管理密钥不对……要 management.secret-key 的明文，不是 bcrypt 哈希」 |
  | 连续错密钥 → 封禁 | 升级成「CPA 把这个 IP 临时封了……还剩约 1m0s。别继续重试」 |
  | `npm run setup` 密钥正确 / 错误 | `✓ 管理密钥有效，读到 2 个凭据文件` exit 0 / `⚠️ HTTP 401` exit 2 |

  做桩时踩的坑：`disabled` 只能存在 `FILES` 里、`/accounts` 响应现算（真 CPA 就是这样），
  各存一份会出现「auth-files 已停用、accounts 还说启用中」的假象，把正常行为误判成 bug。

- **解封后在真机走完整链路（已通过）**：
  8 个号全 `disabled:false`、remain 30429；建带 `selected` + `requestsPerDay:2` 的 key，
  连发 3 次 `200 / 200 / 429` 且全部落在指定 2 个号内、账本只增 2 行、还原后 `enabled=8`；
  `npm run setup` 自动嗅探到 `sk-cpa-local-2026`、校验读到 16 个凭据文件；
  用 setup 产物起服务后 `/healthz` 报 `from: "config"`，建 key + 调模型 **200**。

  也就是说：**「别人拉下来能不能用」这条目标已达成**，前提是那人已有可用的 CPA 与已登录账号。

- **连通状态与 key 可用性显示（已验收，2026-11-12 20:46）**：

  | 场景 | 结果 |
  | --- | --- |
  | 数据面探针（真 CPA） | `ok:true`，HTTP 200，3ms |
  | 管理面探针（真 CPA） | `ok:true`，60ms |
  | 隧道未启动 | `running:false`、`reason: fetch failed`，圆点红，页脚提示「手机在外面用不了」 |
  | 隧道运行中 | `running:true`、connector 匹配、`readyConnections:1` |
  | 点「测公网」 | **200**，2336ms，回连的 `healthz` 里 `upstreamKey/ adminKey` 都 ok，页脚变「三条都通」 |
  | 停掉隧道后 | 立刻回到 `running:false` |
  | 别人的隧道占着 20241 | 正确判 `connector-mismatch`，不误报运行中 |
  | 每把 key 的「上次调用」 | `上次调用成功 200 · 899ms · 落号 0f4f3a92`；没调过的显示「还没用过」 |
  | 额度用完的 key | `blocked` 生效，显示「今日额度已满，现在调用会被 429 拦下」而不是假绿 |

## 待办

见 [docs/PLAN.md](docs/PLAN.md)。A / B / C / D / E 五节全部完成，
只剩一个可延后的 `dsh-cpa-switch` 搬迁。

## 活跃坑

- **cloudflared 的 metrics 端口是全局的**：默认 `127.0.0.1:20241`，机器上任何一条隧道都能占着它。
  只探「端口有响应」会把**别人的隧道**认成日志里那条还活着，
  然后在页面上显示一个早已失效的公网地址（实测踩过：起一条测试隧道，生产页面立刻误报「运行中」）。
  解法：拿 `tunnel.log` 里的 `Generated Connector ID` 与 `/ready` 回来的 `connectorId` 比对，
  不一致判 `connector-mismatch`。改这段逻辑时别把它简化回「端口通就算活」。
- **429 不写账本，所以 `lastCall` 会骗人**：被日额度拦下的 key 上一次真正记账还是成功那次。
  只显示 `lastCall` 会得出「一切正常」的错误结论。`/admin/api/state` 因此额外给了
  `blocked`（当前是否会被额度闸门拦住），页面优先显示它。
- **CPA 有 IP 级失败封禁**：连续用错的管理密钥打 `/v0/management/*` 会被封约 30 分钟，
  报 `403 {"error":"IP banned due to too many failed attempts. Try again in 29m41s"}`，
  而且**每次重试都重新计时**。数据面 `/v1/*` 不受影响。
  所以：**别用假管理密钥去测真 CPA**（本文档的验收就是这样把这台机器封了 30 分钟），
  要测「密钥错误」的分支就对打桩上游测。`tools/setup.mjs` 也已经改成空 key 时不打管理接口，
  免得用户还没开始配就被封。
- **`readPool()` 曾经把失败当空池**：CPA 出错时回 `{error: "..."}`，不检查 `response.ok`
  就会走 `accountsBody?.accounts ?? []` 得到 `[]`，返回 `ok:true, accountCount:0` ——
  页面显示「池子是空的」，用户以为号没了。任何读上游的地方都必须先看状态码。
- **`lib/ui.mjs` 整个文件是一个模板字符串**：里面写注释不能出现反引号，
  否则模板提前结束，报 `SyntaxError: Unexpected identifier`。
  同理不能出现 `${`（会被当真插值）。改完跑 `npm run check` + 数一下反引号行数（应为 6）。
- **`Start-Process -Environment` 带 USERPROFILE 会崩**：本机会报
  `subprocess-local: Windows Job runner exited with exit code 4294967295`。
  模拟空 HOME 要用 `cmd /c "set USERPROFILE=…&& …"` 包装。
- **重启服务要看端口真的释放**：`taskkill` 之后端口可能短暂停在 `CLOSED`（进程没退干净），
  这时新进程报 `EADDRINUSE` 而旧进程已经不服务请求了 —— 页面看起来"活着"其实是僵尸。
  `netstat -ano | findstr :8318` 看到 `LISTENING` 行才动手。
- **流式 chunk 必须先 `Buffer.from(chunk)`** 再 `toString('utf8')`；
  直接对 `Uint8Array` 调 `toString('utf8')` 得到 `"104,101,…"`，usage 永远为 0 且无报错。
- **HTTP 头只能是 ASCII**：中文 key 名字塞进响应头会让 `writeHead` 抛错。
- **解析请求体不能用按文件路径读的函数**：曾让每把 key 都叫「未命名」，HTTP 200。
- **启动必须回放当日账本**（`seedDayUsage`）：否则重启把当日额度清零，限额形同虚设。
- **`data/` 与 `bin/` 不进 git**：前者含 key 明文（含 `config.json` 里 CPA 那两个密钥），后者是 52 MB 二进制。
- **还原发生在响应之后，不是响应之前**：`forwardToUpstream()` 里已经 `response.end()`，
  `finally { await restore() }` 才逐个 PATCH 回 CPA。实测响应返回瞬间启用集合仍是截窄的 2 个，
  约 1～2 次探测轮询（≈100ms）后才回到 8。同进程的并发请求被 `withScopeLock` 挡住，
  但**本机其它直接打 CPA 的客户端**会在这段窗口里看到被截窄的池子。要彻底消掉得先还原再发响应，
  代价是流式路径做不到（数据边来边发）。
- **`X-Cpa-Trace-Id` 只在 200 上有**：CPA 的 4xx（如 `model_not_found`）不带这个头，
  所以「按 key 记账里的 `account`」在失败请求上恒为空。别把空 `account` 当成调度异常。
- **`/favicon.ico` 会命中转发层**：现在落进 `proxy()` 的 `not_found` 分支回 401 类错误，
  浏览器控制台会有一条红字。不影响功能，但别误判成页面报错。
- **`git push` 别信 `gh` 的绿灯**：本机全局配了
  `http.https://github.com/.proxy=socks5h://127.0.0.1:7897`，但那个端口当时没有进程在听。
  `github.com:443` 的 TCP 能连、TLS 握手被阻断，于是 push 直接超时；
  而 `api.github.com:443` 是通的，所以 `gh repo view` / `gh api` 全绿 ——
  很容易误判成 token 权限问题。解法：remote 走 SSH 的 443 口
  （`git@ssh.github.com:cslkkl/<repo>.git`），并且**必须**显式
  `-o ProxyCommand=none`，否则 `~/.ssh/config` 里那条
  `ProxyCommand connect -S 127.0.0.1:7897` 会把连接再丢给那个不存在的代理。

  ```powershell
  git remote set-url origin git@ssh.github.com:cslkkl/<repo>.git
  $env:GIT_SSH_COMMAND='ssh -o ProxyCommand=none -o StrictHostKeyChecking=accept-new'
  git push -u origin main
  ```

## 文档地图

- 架构与防错清单 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 交接与待办 → [docs/PLAN.md](docs/PLAN.md)
- 决策与依据 → [.agents/notes/](.agents/notes/)
- 门面（对外）→ [README.md](README.md)

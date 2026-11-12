# BuddyKey — 维护索引

一次会话的入口：规则速查 + 常用命令 + 待办 + 活跃坑 + 文档地图。

## 全局规则

- **只放行一个模型**：`wb/deepseek-v4.1-flash`。其余返回 404，不改写。
- **管理密钥永不下发浏览器**：页面只调本服务 `/admin/api/*`。
- **key 明文只在本机**：`data/keys.json`；列表只暴露遮罩串。
- **范围还原必须在 `finally`**：漏了会让别的客户端看到被截窄的池子，且**无告警**。
- **零依赖**：不引 npm 包；`lib/` 只放纯计算与静态资源。

## 常用命令

```bash
npm start                     # 启动（等价 node server.mjs）
npm run check                 # 语法自检（server.mjs + lib/ui.mjs）
npm run check:docs            # 文档相对链接 + 换行约定（tools/check-docs.ps1）
```

验收要在**隔离副本**里跑，别污染 `data/`：

```powershell
# 复制 server.mjs + lib/ 到临时目录，造一份改过端口的 data/config.json，
# 再 npm start 之外直接 node server.mjs，用 8399 之类的空端口跑。
# 这样真实 key 明文、真实账本一行都不会被测试写脏。
```

## 验证快照

- 语法：`npm run check` 通过（`server.mjs` + `lib/ui.mjs`）；`npm run check:docs` 0 失效链接、换行合规。
- 真机：登录 / 账号列表 / 单模型放行 / 公网隧道调用 均已验过（2026-11-12）。
- **线上进程已换成新代码**（2026-11-12 18:57，pid 见 `data/server.log`）：
  `127.0.0.1:8318` 覆盖启动一次，`/healthz` 200 `keys:2`，首页 43 KB、
  两个占位符无残留、含 `--hairline:#e8e8ed`（新 UI 生效），
  用真实 key 实调一次 `deepseek-v4.1-flash` 得 200 并落号 `b6cb402f71d99636`，
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

## 待办

见 [docs/PLAN.md](docs/PLAN.md)。A / B / C 三节已全部完成（含推到 `cslkkl/cpa-Buddykey`），
剩下的是 D 节里两条校验 —— 已用本项目自带的 `npm run check:docs` 覆盖，
以及一个可延后的 `dsh-cpa-switch` 搬迁。

## 活跃坑

- **流式 chunk 必须先 `Buffer.from(chunk)`** 再 `toString('utf8')`；
  直接对 `Uint8Array` 调 `toString('utf8')` 得到 `"104,101,…"`，usage 永远为 0 且无报错。
- **HTTP 头只能是 ASCII**：中文 key 名字塞进响应头会让 `writeHead` 抛错。
- **解析请求体不能用按文件路径读的函数**：曾让每把 key 都叫「未命名」，HTTP 200。
- **启动必须回放当日账本**（`seedDayUsage`）：否则重启把当日额度清零，限额形同虚设。
- **`data/` 与 `bin/` 不进 git**：前者含 key 明文，后者是 52 MB 二进制。
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

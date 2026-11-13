# BuddyKey — 维护索引

一次会话的入口：规则速查 + 常用命令 + 待办 + 活跃坑 + 文档地图。

## 全局规则

- **绝不把密钥交上去**：这个仓库**是公开的**，而它管的恰好是一堆敏感东西
  （API key、管理口令、账号登录态）。`data/`、`runtime/`、`bin/` 已被 `.gitignore` 排除，
  但 `git add -f` 能绕过去 —— 所以有 `tools/check-secrets.mjs` 兜底：
  `npm run check` 会跑它，`npm run hooks:install` 装的 pre-commit 钩子也会跑它。
  真提交过一次就**必须作废那个密钥**（重建），删文件没用 —— 别人可能已经 fork。
- **只放行一个模型**：默认 `wb/deepseek-v4.1-flash`，但**不要写死** —— 启动时从 CPA 探测
  （插件换版本时前缀会从 `wb/` 变 `cn/`，已实测到）。配置里留空 `model` 即走探测。
- **管理密钥永不下发浏览器**：页面只调本服务 `/admin/api/*`。
- **key 明文只在本机**：`data/keys.json`；列表只暴露遮罩串。
- **范围还原必须在 `finally`**：漏了会让别的客户端看到被截窄的池子，且**无告警**。
- **零依赖**：不引 npm 包；`lib/` 只放纯计算与静态资源，`tools/` 只放脚本。
- **密钥来源三级**：`data/config.json` > 环境变量 > `~/.dsh/.credentials.yaml` 的 refs。
  改了顺序要同步 `/healthz` 的 `*From` 字段与管理页引导卡片。
- **第三方二进制只走官方 release 且校验 sha256**：`tools/upstream.mjs` 装的所有东西
  都从 GitHub release 下、比对 API 给的 `digest` 后才落盘。别改成「下完直接用」。
  上游没给 digest 时跳过校验，但必须**如实报 `verified: false`**，不能当成校验通过。

## 常用命令

```bash
npm run install-cpa           # 装上游：下载 CPA + workbuddy 插件 + 生成配置（约 30 MB）
npm run cpa                   # 起上游 CPA
npm start                     # 起 BuddyKey（等价 node server.mjs）
npm run setup                 # 只配 BuddyKey 的两个密钥（上游已在别处时用）
npm run check:updates         # 命令行查上游有没有新版（只读）
npm run oauth-region cn       # 切登录区域（cn=国内 / intl=国际），改完重启 CPA
npm run fake-cpa              # 起一个假 CPA（默认 8390），测密钥错误 / 封禁分支用
npm run check                 # 语法 + 页面结构 + 平台资产 + 密钥扫描，全跑
npm run check:secrets         # 只跑密钥扫描（防把真实 key 提交进公开仓库）
npm run hooks:install         # 装 pre-commit 钩子：提交前自动跑密钥扫描
npm run check:docs            # 文档相对链接 + 换行约定（tools/check-docs.ps1）
```

**新 clone 后第一件事**：`npm run hooks:install` —— 这个仓库是公开的，
钩子会在 `git commit` 那一刻拦住误提交的密钥，比事后补救有效得多。

`install-cpa` 的三个开关，别记错：

```bash
npm run install-cpa                        # 交互；探测到已有 CPA 就默认复用
npm run install-cpa -- --reuse             # 明确复用已有的（不下载）
npm run install-cpa -- --download          # 明确装本项目专用那套
npm run install-cpa -- --download --force  # 连已下好的也重下
```

**上游版本：只报、不自动升级。** 页面「连通状态」下面有一行显示
「已装 → 上游」，要换得点「更新」。判据是 **release tag 是否相等**，不解析版本号。
三条不许含糊的口径（与 dsh-cpa-switch 一致，见那边 2026-10-12 决策记录）：

- 没记录过安装 tag → 说「未知」，**不能**说「有新版」也不能说「已是最新」；
- 查不到上游（断网/限流）→ 说「查不到」，不能说「已是最新」；
- 认不出响应 → 什么都不说，不印「已是最新」替后端撒谎。

```bash
node tools/cpa-update.mjs --check          # 只看
node tools/cpa-update.mjs --apply          # 真换（必须先把 CPA 停掉）
node tools/cpa-update.mjs --check --key=cpa
```

**装完之后：模型名不要写死。** `data/config.json` 的 `model` 留空 = 启动时问 CPA；
插件换版本时前缀会从 `wb/` 变 `cn/`（已实测到），写死会得到「装完都对、一调 400
unknown provider」这种极难查的失败。更新完插件服务端会**重新探测一次**，
所以别绕过 `/admin/api/updates` 直接手改 `runtime/` 里的文件。

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
  | `npm run setup` 交互 / 非交互 | 都能写 `data/config.json`；上游 key 从 CPA `access.api-keys` 自动嗅探成 `sk-cpa-example` |

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
  `npm run setup` 自动嗅探到 `sk-cpa-example`、校验读到 16 个凭据文件；
  用 setup 产物起服务后 `/healthz` 报 `from: "config"`，建 key + 调模型 **200**。

  也就是说：**「别人拉下来能不能用」这条目标已达成**，前提是那人已有可用的 CPA 与已登录账号。
  → 这条前提已在 2026-11-13 由 `npm run install-cpa` 消掉，见下面那条。

- **上游自带安装器（2026-11-13 已验收）**：
  从零（隔离副本，无 `runtime/`）跑 `node tools/install-cpa.mjs --download`：

  | 步骤 | 结果 |
  | --- | --- |
  | 查 CPA release | `v8.0.69`（2026-11-12） |
  | 下 CPA zip | 24.8 MB，`sha256 ✓`（与 API 给的 digest 一致） |
  | 解出 exe | `runtime/cpa/cli-proxy-api.exe`，75 MB |
  | 查插件商店 | registry 里 `workbuddy` = CodeBuddy Intl CPA `v0.10.0`（zidanefaqih） |
  | 下插件 zip | 3.2 MB，`sha256 ✓` |
  | 解出插件 | `runtime/cpa/plugins/workbuddy.dll`，8 MB |
  | 生成 config | `server.port=8320`、`access.api-keys`、`management.secret-key` 都写好 |
  | 写 BuddyKey 配置 | `data/config.json` 的 `upstreamKey` / `adminKey` 已填 |

  然后 `npm run cpa` 起它：CPA `8.0.69` 启动、插件注册为
  `CodeBuddy Intl CPA version=0.10.0`、`API server started successfully on 127.0.0.1:8320`。
  实测数据面 200、管理面 200、账号列表 `count=8`、登录能拿到 `codebuddy.ai` 授权地址。

  **这一步挖出了本轮的 key 问题**：旧插件暴露 `wb/…`，新插件暴露 `cn/…`，
  模型名写死会让「装完全对、一调 400」。已改成启动探测（见活跃坑第一条）。

- **生产环境的模型探测也验过（2026-11-13 12:20）**：
  把生产 `data/config.json` 的 `model` / `acceptModels` 去掉后重启，
  `/healthz` 报 `modelSource: "probe"`、`model: "wb/deepseek-v4.1-flash"`
  （本机是旧版插件，探测到 `wb/` 前缀），启动日志还打印了
  「插件换了前缀：兜底猜的 cn/… 不存在，实际用探测到的」。
  `/v1/models` 报三个别名，用短名 `deepseek-v4.1-flash` 调用返回 **200**，
  落号 `0f4f3a929bd81dc3`。生产保持探测模式。

- **上游版本检测与更新（2026-11-13 已验收，参考 dsh-cpa-switch 的机制）**：

  | 场景 | 结果 |
  | --- | --- |
  | 没记过安装 tag | `installed: null`，页面「已装版本未知（本版未记录）· 上游当前 v0.10.0」+「更新」 |
  | 记录与上游一致 | `hasUpdate: false`，页面「已是 v0.10.0，与上游一致」，**不给按钮**（绿点） |
  | 记录旧于上游 | `hasUpdate: true`，页面 `v0.9.9 → v0.10.0` +「更新」 |
  | 查不到上游 | `ok:false, reason:"release-query-failed"`，页面「查不到上游版本：…」+「重试」 |
  | 不认识的 `?key=` | HTTP 400 `unknown-source` |
  | **CPA 在跑时点更新** | **HTTP 409 拒绝**，页面「CPA 还在运行，插件文件被占用…先停掉它」，磁盘 0 字节改动 |
  | CPA 停着时点更新 | **HTTP 200**，7s 完成下载+校验+解压，`verified:true`，`stopped:true` |
  | 更新后 | `runtime/install.json` 记下 `tag: v0.10.0`，再查变「已是最新」 |
  | 更新后重探模型 | 响应带 `model` / `modelSource` / `models`，页面同步 `state.model` |
  | 首屏不自动查版本 | 只渲染「未知」，点「查上游版本」才打 GitHub（未认证限流 60 次/小时） |
  | Playwright 实测 | `updateView is not defined` → 定位到注入点在 `<script>` 外，包进去后只剩 favicon 401 |
  | `npm run check` | 语法 8 个文件 + `check-ui.mjs` 结构断言 + `selftest-update-text.mjs` 六态，全过 |
  | `node tools/cpa-update.mjs --check` | 真实上游 `v0.10.0`，如实报「未知（本版未记录）」 |

  三条「不许含糊」的口径都有对应断言：没记录 ≠ 有新版、查不到 ≠ 已是最新、认不出就不说话。
  测试手法：故意把 `runtime/install.json` 的 tag 改旧来造「有新版」，
  起 `fake-cpa` 来造「CPA 在跑」—— 不用碰真 CPA。

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

见 [docs/PLAN.md](docs/PLAN.md)。A~E 五节 + F 节（上游自带安装器）全部完成，
只剩一个可延后的 `dsh-cpa-switch` 搬迁。

## 活跃坑

- **插件前缀会变，模型名绝不能写死**：同一条 workbuddy 渠道，
  `workbuddy.dll` v0.9.89（腾讯 CN 版）暴露的是 `wb/deepseek-v4.1-flash`，
  官方插件商店的 CodeBuddy Intl CPA v0.10.0 暴露的是 `cn/deepseek-v4.1-flash`。
  写死的结果是「装完什么都对、一调就 400 unknown provider」，而报错指向 model 不指向插件版本，
  极难查（实测踩过）。现在 `server.mjs` 启动时 `await probeModelCatalog()` 探测，
  `/healthz` 的 `modelSource` 会报 `probe` / `config` / `fallback`。
  **探测必须 await**，否则会有「前几个请求按兜底名打、全 400，过一会儿又自己好了」的竞态。
- **`github.com:443` 的 TLS 可能被阻断，`api.github.com` 却是通的**：
  所以安装器一律走 `api.github.com` 取 release 元数据与资产
  （`GET /releases/assets/:id` + `Accept: application/octet-stream`），
  不要用 `browser_download_url`（那指向 github.com，会卡死）。
  同类坑见文末的 `git push` 那条。
- **插件原仓库 `mmqz/cpa-multi-plugins` 已 404**：现在的正源是官方插件商店
  `router-for-me/CLIProxyAPI-Plugins-Store` 的 `registry.json`，
  其中 `workbuddy` 条目的 `author` 是 `zidanefaqih`，release 资产名形如
  `workbuddy_<ver>_<os>_<arch>.zip`。改下载逻辑时按 registry 走，别硬编码仓库名。
- **自己写 zip 解压时，数据起点要用本地头的 name/extra 长度**：
  中央目录里的 extra 常与本地头不同（带 unicode path 扩展时），
  拿中央目录的长度去算会整体偏移，解出来是坏字节而且**不会报错**。
  见 `tools/zip.mjs` 的 `readZipEntry`。
- **`fetch` 连接被拒时，`ECONNREFUSED` 在 `error.cause.code` 里**，不在 `message`（message 只是
  `fetch failed`）。按 message 判断会把「端口没人听」误判成「被占用」，
  于是明明能起却拒绝启动（`install-cpa` 与 `run-cpa` 都踩过）。
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
  同理不能出现 `${`（会被当真插值）。
  ⚠️ **更阴的一种**：两个反引号恰好配对时，`node --check` **照样通过**，
  页面却被截断成半截 —— 浏览器里表现成「样式没了 / 按钮不响应」，排查方向全跑偏（本轮踩过）。
  所以不只靠 `--check`，`tools/check-ui.mjs` 直接断言 PAGE 从 `<!doctype html` 开始、
  到 `</body></html>` 结束、三个占位符各 1 次、五个结构锚点都在。改完跑 `npm run check`。
- **注入到页面的第三方脚本必须包在独立 `<script>` 里**：
  `__UPDATE_TEXT__` 一开始被我放在 `<script>` 标签外面，纯文本不会执行，
  浏览器报 `updateView is not defined`，而服务端一切正常 —— 只看接口测不出来，必须开页面看控制台。
- **上游版本只报不自动升级**（照 dsh-cpa-switch 的 2026-10-12 决策）：
  上游随时可能改行为（模型前缀、请求形状都改过），静默替换等于把它的风险直接灌给用户。
  判据是 **release tag 相等**，不解析 semver —— 两个 tag 都显示，谁新谁旧由人看。
  「没记录」「查不到」「认不出」三种情况必须显示成**三句不同的话**，
  混成「已是最新」就是替后端撒谎。
- **更新插件前必须确认 CPA 停着**：Windows 上被加载的 dll 改不了名。
  判据是 `probeDataPlane().reached`（**不是** `.ok`）—— CPA 回 401 也说明进程活着、文件被占。
  只看 `.ok` 会在密钥不对时误判成「没跑」，然后拿一个看不懂的 EBUSY。
  BuddyKey 不是 CPA 的父进程，所以它**不停也不能停**别人的进程：只检测 + 如实报错。
- **更新完必须重新探模型目录**：插件换版本时前缀会变（`wb/` ↔ `cn/`）。
  漏掉这一步会得到「插件更新成功、之后每个请求都 400 unknown provider」，
  而报错指向 model，完全看不出跟刚才那个更新有关。`POST /admin/api/updates` 里已接。
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
  这条有脚本兜底：`tools/check-secrets.mjs` 会检查「有没有被跟踪的敏感路径」与
  「内容里有没有真密钥形状」，`npm run check` 与 pre-commit 钩子都会跑。
  它故意**只认真货的形状**（`sk-pool-` + 32 位十六进制等），不猜占位符写法 ——
  否则「文档里写 `sk-pool-你的key`」会被误判，检查就被关掉了。
- **密钥检查有两道，别只留一道**：`npm run check` 是**手动**的，忘了跑就漏；
  pre-commit 钩子拦在「真要写进 git」那一刻才有效。新 clone 后先 `npm run hooks:install`。
  钩子会备份已有的 `pre-commit`（`.git/hooks/` 不受版本控制，所以只能靠这条命令装）。
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

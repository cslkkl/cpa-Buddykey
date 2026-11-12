# BuddyKey 架构说明

## 目标

把分散在多个 WorkBuddy 账号上的额度，变成一个可管理的 API 面：

- 一把钥匙一个身份，能独立撤销；
- 每把钥匙能看自己的用量、能限额、能限定用哪几个号；
- 上层协议保持 OpenAI 兼容，客户端不用改代码。

## 不可破坏的约束

1. **只放行一个模型**：`wb/deepseek-v4.1-flash`（workbuddy 渠道的 deepseek-v4.1）。
   其余模型返回 404 `model_not_found`，不改写、不静默降级。
2. **管理密钥不下发浏览器**：管理页只调本服务的 `/admin/api/*`，CPA 的管理密钥只在宿主进程里。
3. **key 明文只在本机**：存 `data/keys.json`，不出网；列表只暴露遮罩串。
4. **超限不花上游额度**：日额度在转发之前判断，超了直接 429。
5. **记账先于响应**：每次真正打到上游的请求都写一行 `data/usage.jsonl`。

## 数据流

```
客户端 (OpenAI SDK / 手机 App)
   ↓ Authorization: Bearer sk-pool-…
server.mjs  ── 校验 key → 判日额度 → 判账号范围
   ↓ 127.0.0.1:8317  /v1/chat/completions
CPA（cli-proxy-api）── 从启用的凭据里挑一个号
   ↓ https
copilot.tencent.com（WorkBuddy 上游）
```

账号登录走 CPA 的 `GET /v8/management/oauth/auth-url?provider=workbuddy`，
拿到腾讯授权地址；授权完成后 CPA 把 token 落盘，账号即进入池子。

## 两个功能的实现口径

### 日额度

- 计数存在内存（`dayUsage`），启动时从 `usage.jsonl` **回放当天**的行，
  否则重启会把当日用量清零、限额失效。
- 「一天」按本机本地时区算；跨天自动清零。
- 两条独立上限：`requestsPerDay`（请求次数）与 `creditsPerDay`（积分）。
  空值 = 不限。
- 超限返回 `429` + `Retry-After`（到本地午夜的秒数）+ `rate_limit_error` 错误体。
- **只有真正打到上游的请求才计数**：401 / 404 / 429 不吃当日额度。

### 账号范围

- 存 `{ mode: "all" | "selected", accounts: [auth_index] }`。
- `selected` 但列表为空时按 `all` 处理：空集合会让这把 key 永远 429，几乎必然是误操作。
- 执行方式：请求前用 `PATCH /v0/management/auth-files/status` 把全局启用集合调成本 key
  的范围，请求结束（含异常）在 `finally` 里还原。

**为什么不能更干净**：CPA 的 `access.api-keys` 只是裸字符串，路由只有
`round-robin` / `fill-first` / 权重排除，没有「按 key 绑定账号」的能力
（已核对 `config.example.yaml` 的 access 与 routing 两段）。

**由此带来的已知限制**：

1. 切换是全局的 —— 同一瞬间另一个客户端会看到启用集合被短暂改动；
2. 范围请求因此**串行执行**（`withScopeLock`），并发排队而非互相踩；
3. 还原只针对「本次改动过的文件」，不会把用户手动停用的号又打开。

**还原的真实时序**（2026-11-12 实测，别按直觉想）：

`forwardToUpstream()` 内部就已经 `response.end()` 了，`finally { await restore() }` 才逐个
`PATCH /v0/management/auth-files/status` 改回 CPA。所以客户端拿到 200 的那一刻，
CPA 的启用集合**还是截窄的**；实测响应返回瞬间读到 2 个启用号，约 100ms（6 次串行 PATCH，
每跳≈20ms）后才回到 8 个。

- 同进程的下一个请求被 `withScopeLock` 挡在锁外，不会挤进这个窗口；
- 但**本机其它直接打 CPA 的客户端**（例如 DSH 自己的调用）会在这个窗口里被截窄。
- 想彻底消掉，只能「先还原再发响应」；流式路径做不到（数据边来边发），
  非流式路径可以但要改 `forwardToUpstream` 的结构，收益是消失约 100ms 的窗口 —— 目前判定不值得。

## 目录约定

```
BuddyKey/
├── server.mjs        HTTP + 转发 + 额度 + 范围（入口）
├── lib/ui.mjs        管理页（HTML 字符串，Apple 极简风）
├── data/             运行时状态（keys / usage / config / 隧道日志）
├── bin/              cloudflared（不入库）
└── docs/ .agents/    文档网络
```

`data/` 与 `bin/` 都被 `.gitignore` 排除：前者含 key 明文，后者是 52 MB 二进制。

## 防错清单

- **流式 chunk 必须先过 Buffer**：`Uint8Array.toString('utf8')` 会得到 `"104,101,…"`，
  usage 永远解析成 0，且没有任何报错。
- **HTTP 头只能是 ASCII**：任何中文 key 名字塞进响应头都会让 `writeHead` 抛错。
- **解析请求体不能用按文件路径读的那个函数**：曾经每把 key 都叫「未命名」，HTTP 200。
- **范围还原必须在 finally**：漏了会让别的客户端看到一个被截窄的池子，无告警。

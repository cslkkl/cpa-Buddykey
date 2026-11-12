/**
 * BuddyKey —— 登录 WorkBuddy 账号，把账号池做成「像控制台那样的具名 API Key」。
 *
 * 为什么需要这一层：CPA 自己的 `access.api-keys` 只是一串裸字符串
 * （实测 `{"api-keys":["sk-cpa-local-2026"]}`），没有名字、没有 Tracking ID、
 * 没有创建/最后使用时间，也不按 key 记账。要做成控制台那种表格、按 key 查用量、
 * 按 key 限额与限号，只能在 CPA 前面加一个很小的网关。
 *
 * 它做五件事：
 *   1. 签发 / 列出 / 改名 / 启停 / 删除**具名 key**（每个 key 带 Tracking ID）；
 *   2. 代理到本机 CPA，只放行**一个模型**：workbuddy 渠道的 `wb/deepseek-v4.1-flash`；
 *   3. 按 key 记账：token / 积分 / 落在哪个号 / 客户端 IP；
 *   4. 按 key **日额度**：超了直接 429，不花上游一分钱；
 *   5. 按 key **限定账号**：只允许调度到指定的那几个号。
 *
 * 目录约定：代码在根，运行时数据在 `data/`（`bin/` 放 cloudflared，均不入库）。
 * 零依赖、默认只监听 127.0.0.1。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 运行时数据统一放 `data/` —— 代码在根，状态与二进制分开，删状态不影响代码。 */
const DATA_DIR = path.join(HERE, 'data')
const KEYS_FILE = path.join(DATA_DIR, 'keys.json')
const USAGE_FILE = path.join(DATA_DIR, 'usage.jsonl')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
fs.mkdirSync(DATA_DIR, { recursive: true })

/** 默认配置；`config.json` 里写了什么就覆盖什么。 */
const DEFAULTS = {
  host: '127.0.0.1',
  port: 8318,
  /** 上游：本机 CPA。 */
  upstream: 'http://127.0.0.1:8317',
  /** 上游 key 从 `~/.dsh/.credentials.yaml` 的 refs 段按名字取，不落第二份。 */
  upstreamKeyRef: 'CPA_API_KEY',
  adminKeyRef: 'CPA_ADMIN_KEY',
  /** 这一层锁死的渠道与模型。 */
  channel: 'workbuddy',
  model: 'wb/deepseek-v4.1-flash',
  /** 用户可能随手写的别名，全部归一到上面那个模型。 */
  acceptModels: ['wb/deepseek-v4.1-flash', 'wb/deepseek-v4.1', 'deepseek-v4.1-flash', 'deepseek-v4.1'],
  maxBodyBytes: 32 * 1024 * 1024,
}

const CONFIG = { ...DEFAULTS, ...readJson(CONFIG_FILE, {}) }
const CREDS = readCredentialRefs()
const UPSTREAM_KEY = CREDS[CONFIG.upstreamKeyRef] ?? ''
const ADMIN_KEY = CREDS[CONFIG.adminKeyRef] ?? ''

/* ────────────────────────────── 基础工具 ────────────────────────────── */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/** ⚠️ 只解析字符串，**不读文件** —— 曾经把请求体喂进 `readJson`（它按文件读），
 *  于是 body 永远解析失败、每把 key 都叫「未命名」，而 HTTP 200 看不出问题。 */
function parseJsonText(text, fallback) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** 从 `~/.dsh/.credentials.yaml` 的 `refs:` 段取凭据（只取用得到的几个）。 */
function readCredentialRefs() {
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  try {
    const text = fs.readFileSync(file, 'utf8')
    const refs = {}
    let inRefs = false
    for (const line of text.split(/\r?\n/)) {
      if (/^refs:\s*$/.test(line)) {
        inRefs = true
        continue
      }
      if (/^\S/.test(line)) {
        inRefs = false
        continue
      }
      if (!inRefs) continue
      const m = /^\s+([A-Za-z0-9_.-]+):\s*(\S+)\s*$/.exec(line)
      if (m !== null) refs[m[1]] = m[2]
    }
    return refs
  } catch {
    return {}
  }
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...CORS, ...headers })
  res.end(body)
}

/** 手机 App / 网页客户端都可能跨源调用；这一层只在本机局域网里听，放开 CORS 是安全的。 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
}

function jsonRes(res, value, status = 200) {
  send(res, status, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(value))
}

/** OpenAI 形状的错误体 —— 客户端 SDK 认这个。 */
function openaiError(res, status, message, code, param) {
  jsonRes(res, { error: { message, type: 'invalid_request_error', code, param } }, status)
}

/* ────────────────────────────── key 存储 ────────────────────────────── */

const store = readJson(KEYS_FILE, { keys: [] })
if (!Array.isArray(store.keys)) store.keys = []

function saveKeys() {
  writeJson(KEYS_FILE, store)
}

/** 日额度：两项都允许为空（= 不限）。元数据一律存成 `number | null`。 */
function normalizeQuota(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const pick = (value) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
  }
  return {
    requestsPerDay: pick(source.requestsPerDay),
    creditsPerDay: pick(source.creditsPerDay),
  }
}

/**
 * 账号范围：`mode` 只有两种。
 *
 * ⚠️ `selected` 且 `accounts` 为空时**当成全部** —— 空集合是「一个号都不许用」，
 * 那会让这个 key 永远 429，几乎必然是用户误操作，不该让它变成静默陷阱。
 */
function normalizeScope(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const mode = source.mode === 'selected' ? 'selected' : 'all'
  const accounts = Array.isArray(source.accounts)
    ? [...new Set(source.accounts.filter((item) => typeof item === 'string' && item !== ''))]
    : []
  return mode === 'selected' && accounts.length > 0
    ? { mode: 'selected', accounts }
    : { mode: 'all', accounts: [] }
}

function newKeyRecord(input) {
  const hex = randomBytes(16).toString('hex')
  const name = typeof input?.name === 'string' ? input.name.trim() : ''
  return {
    id: randomUUID(),
    name: name === '' ? '未命名' : name.slice(0, 60),
    key: `sk-pool-${hex}`,
    trackingId: randomUUID(),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    enabled: true,
    quota: normalizeQuota(input?.quota),
    scope: normalizeScope(input?.scope),
  }
}

/** `sk-pool-1a2b3c****9f0e` —— 与截图里 `sk-8c744e****459c` 同一套遮法。 */
function maskOf(key) {
  const body = key.replace(/^sk-pool-/, '')
  return `sk-pool-${body.slice(0, 6)}****${body.slice(-4)}`
}

function keyByToken(token) {
  if (token === '') return undefined
  return store.keys.find((item) => item.key === token)
}

function quotaOf(record) {
  return normalizeQuota(record?.quota)
}

function scopeOf(record) {
  return normalizeScope(record?.scope)
}

/* ──────────────────────────── 上游池子信息 ──────────────────────────── */

/** 打一次 CPA 管理接口（带管理 key）。 */
async function cpaAdmin(path, init = {}) {
  const response = await fetch(`${CONFIG.upstream}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ADMIN_KEY}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text === '' ? {} : JSON.parse(text)
  } catch {
    parsed = { raw: text }
  }
  if (!response.ok) throw new Error(`CPA ${String(response.status)}: ${JSON.stringify(parsed).slice(0, 200)}`)
  return parsed
}

/**
 * 账号列表：把「账号」与「余额」按 auth_index 合成一行。
 *
 * ⚠️ 两个接口分开打：`/accounts` 给昵称 / 启用态 / 平台，`/credits` 给剩余。
 * 合并不上时 remaining 留 `null`，**不填 0**（0 会被读成「没额度了」）。
 */
async function listAccounts() {
  if (ADMIN_KEY === '') return { ok: false, error: 'no-admin-key' }
  try {
    const [accountsBody, creditsBody, filesBody] = await Promise.all([
      cpaAdmin(`/v0/management/plugins/${CONFIG.channel}/accounts`),
      cpaAdmin(`/v0/management/plugins/${CONFIG.channel}/credits`).catch(() => ({ accounts: [] })),
      cpaAdmin('/v0/management/auth-files').catch(() => ({ files: [] })),
    ])
    const creditByIndex = new Map()
    for (const item of creditsBody?.accounts ?? []) {
      const c = item.credits ?? {}
      creditByIndex.set(item.auth_index, {
        remain: c.total_remain === undefined ? null : Number(c.total_remain),
        used: c.total_used === undefined ? null : Number(c.total_used),
        size: c.total_size === undefined ? null : Number(c.total_size),
        packs: Number(c.pack_count ?? 0),
      })
    }
    /** `auth_index` → 凭据文件名：启用/停用那条接口按**文件名**定位，不认 auth_index。 */
    const fileByIndex = new Map()
    for (const file of filesBody?.files ?? []) {
      if (file?.provider === CONFIG.channel && typeof file.auth_index === 'string') {
        fileByIndex.set(file.auth_index, file.name)
      }
    }
    const rows = (accountsBody?.accounts ?? []).map((account) => ({
      authIndex: account.auth_index,
      nickname: account.nickname ?? account.label ?? account.auth_index,
      disabled: account.disabled === true,
      exhausted: account.exhausted === true,
      status: account.status,
      region: account.region,
      fileName: fileByIndex.get(account.auth_index) ?? null,
      credits: creditByIndex.get(account.auth_index) ?? null,
    }))
    rows.sort((a, b) => (b.credits?.remain ?? -1) - (a.credits?.remain ?? -1))
    return {
      ok: true,
      accounts: rows,
      summary: {
        count: rows.length,
        enabled: rows.filter((row) => !row.disabled).length,
        remain: rows.reduce((sum, row) => sum + (row.credits?.remain ?? 0), 0),
        used: rows.reduce((sum, row) => sum + (row.credits?.used ?? 0), 0),
        size: rows.reduce((sum, row) => sum + (row.credits?.size ?? 0), 0),
      },
      autoCheckin: accountsBody?.checkin_auto === true,
      lifecycleAuto: accountsBody?.lifecycle_auto === true,
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 登录会话缓存：`state` → `{ url, startedAt }`，只为界面回显。 */
const loginSessions = new Map()

let poolCache = { at: 0, value: undefined }

/** 读 workbuddy 的账号 + 余额，给管理页显示「池子里还有多少」。缓存 30 秒。 */
async function readPool() {
  const now = Date.now()
  if (poolCache.value !== undefined && now - poolCache.at < 30000) return poolCache.value
  if (ADMIN_KEY === '') return { ok: false, error: 'no-admin-key' }
  try {
    const headers = { authorization: `Bearer ${ADMIN_KEY}` }
    const [accountsRes, creditsRes] = await Promise.all([
      fetch(`${CONFIG.upstream}/v0/management/plugins/${CONFIG.channel}/accounts`, { headers }),
      fetch(`${CONFIG.upstream}/v0/management/plugins/${CONFIG.channel}/credits`, { headers }),
    ])
    const accountsBody = await accountsRes.json()
    const creditsBody = await creditsRes.json()
    const nicknames = new Map()
    for (const account of accountsBody?.accounts ?? []) {
      nicknames.set(account.auth_index, account.nickname ?? account.auth_index)
    }
    const rows = []
    let remain = 0
    let used = 0
    let size = 0
    for (const item of creditsBody?.accounts ?? []) {
      const c = item.credits ?? {}
      const r = Number(c.total_remain ?? 0)
      remain += r
      used += Number(c.total_used ?? 0)
      size += Number(c.total_size ?? 0)
      rows.push({
        authIndex: item.auth_index,
        nickname: nicknames.get(item.auth_index) ?? item.auth_index,
        remain: r,
        used: Number(c.total_used ?? 0),
        size: Number(c.total_size ?? 0),
        packs: Number(c.pack_count ?? 0),
      })
    }
    rows.sort((a, b) => b.remain - a.remain)
    poolCache = {
      at: now,
      value: {
        ok: true,
        channel: CONFIG.channel,
        model: CONFIG.model,
        accountCount: accountsBody?.accounts?.length ?? rows.length,
        remain,
        used,
        size,
        accounts: rows,
      },
    }
    return poolCache.value
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/* ─────────────────────────────── 用量记账 ─────────────────────────────── */

function record(entry) {
  try {
    fs.appendFileSync(USAGE_FILE, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    /* 记账失败不该让请求失败 */
  }
}

function readUsage() {
  try {
    const text = fs.readFileSync(USAGE_FILE, 'utf8')
    const out = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line))
      } catch {
        /* 跳过坏行 */
      }
    }
    return out
  } catch {
    return []
  }
}

/** 从响应体里找**最后一个** `"usage":{...}`（流式时它只在末尾）。 */
function lastUsageObject(text) {
  let idx = text.lastIndexOf('"usage"')
  while (idx >= 0) {
    const brace = text.indexOf('{', idx)
    if (brace >= 0) {
      const slice = sliceBalanced(text, brace)
      if (slice !== undefined) {
        try {
          const value = JSON.parse(slice)
          if (value !== null && typeof value === 'object') return value
        } catch {
          /* 继续往前找 */
        }
      }
    }
    idx = idx > 0 ? text.lastIndexOf('"usage"', idx - 1) : -1
  }
  return undefined
}

function sliceBalanced(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/** CPA 的 `X-Cpa-Trace-Id` = `<时间>-<账号 auth_index>-<请求 uuid>`。 */
function accountOfTrace(traceId) {
  if (typeof traceId !== 'string') return undefined
  const parts = traceId.split('-')
  return parts.length >= 3 ? parts[1] : undefined
}

/* ───────────────────────────── 日额度计数 ───────────────────────────── */

/** 本地日期键（`2026-11-12`）——「一天」按运行这台机器的本地时区算。 */
function localDayKey(at = new Date()) {
  const year = at.getFullYear()
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 今日已用量：`keyId -> { requests, credits }`。
 *
 * ⚠️ 启动时从 `usage.jsonl` **回放当天**的行，而不是从零开始 ——
 * 否则每次重启（改代码、重启电脑）当日额度就被清空，等于限额形同虚设。
 */
let dayKey = localDayKey()
const dayUsage = new Map()

function bucketOf(keyId) {
  let bucket = dayUsage.get(keyId)
  if (bucket === undefined) {
    bucket = { requests: 0, credits: 0 }
    dayUsage.set(keyId, bucket)
  }
  return bucket
}

function seedDayUsage() {
  for (const row of readUsage()) {
    if (typeof row?.ts !== 'string' || row.keyId === undefined) continue
    if (localDayKey(new Date(row.ts)) !== dayKey) continue
    const bucket = bucketOf(row.keyId)
    bucket.requests += 1
    bucket.credits += Number(row.credit ?? 0)
  }
}

function ensureDay() {
  const today = localDayKey()
  if (today !== dayKey) {
    dayKey = today
    dayUsage.clear()
  }
}

function bumpDayUsage(keyId, credit) {
  ensureDay()
  const bucket = bucketOf(keyId)
  bucket.requests += 1
  bucket.credits += Number.isFinite(credit) ? credit : 0
}

function todayOf(keyId) {
  ensureDay()
  const bucket = dayUsage.get(keyId)
  return bucket === undefined ? { requests: 0, credits: 0 } : { ...bucket }
}

/** 到本地午夜还有多少秒 —— 429 的 `Retry-After` 用它。 */
function secondsToMidnight(now = new Date()) {
  const next = new Date(now)
  next.setHours(24, 0, 0, 0)
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000))
}

/** 超额就返回要回给客户的错误（`null` = 没超）。 */
function quotaRefusal(record) {
  const quota = quotaOf(record)
  const used = todayOf(record.id)
  if (quota.requestsPerDay !== null && used.requests >= quota.requestsPerDay) {
    return {
      message: `这把 key 今天的请求数已达上限（${String(quota.requestsPerDay)} 次/天，已用 ${String(used.requests)} 次）。`,
      limit: 'requestsPerDay',
    }
  }
  if (quota.creditsPerDay !== null && used.credits >= quota.creditsPerDay) {
    return {
      message: `这把 key 今天的积分已用尽（上限 ${String(quota.creditsPerDay)}，已用 ${used.credits.toFixed(2)}）。`,
      limit: 'creditsPerDay',
    }
  }
  return null
}

/* ───────────────────────────── 账号范围切换 ───────────────────────────── */

/**
 * 把 CPA 的**启用集合**切成这把 key 允许的那几个号，返回还原函数。
 *
 * 为什么只能这么做：CPA 的 `access.api-keys` 只是裸字符串，路由只有
 * round-robin / fill-first / 权重排除，**没有「按 key 绑定账号」**的能力
 * （已核对 `config.example.yaml` 的 access 与 routing 两段）。
 * 所以只能在每次请求前把全局启用集合调成本 key 的范围，请求结束再还原。
 *
 * ⚠️ 由此带来两个已知限制（写进 README，不假装没有）：
 *   1. 切换是**全局**的：同一瞬间另一个客户端可能在用别的号，会看到启用集合被短暂改动；
 *   2. 因此范围请求**串行执行**（下面的 `withScopeLock`），并发会排队而不是互相踩。
 */
let scopeLock = Promise.resolve()

function withScopeLock(task) {
  const run = scopeLock.then(task, task)
  scopeLock = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function narrowToScope(authIndexes) {
  const files = (await cpaAdmin('/v0/management/auth-files'))?.files ?? []
  const mine = files.filter((file) => file.provider === CONFIG.channel)
  const wanted = new Set(authIndexes)
  const before = new Map()
  const changed = []
  for (const file of mine) {
    const shouldDisable = !wanted.has(file.auth_index)
    const currentlyDisabled = file.disabled === true
    before.set(file.name, currentlyDisabled)
    if (currentlyDisabled !== shouldDisable) {
      changed.push({ name: file.name, disabled: shouldDisable })
    }
  }
  for (const change of changed) {
    await cpaAdmin('/v0/management/auth-files/status', {
      method: 'PATCH',
      body: JSON.stringify(change),
    })
  }
  /** 只还原「我们动过」的文件，别把用户手动停用的号又打开。 */
  return async () => {
    for (const change of changed) {
      const original = before.get(change.name)
      await cpaAdmin('/v0/management/auth-files/status', {
        method: 'PATCH',
        body: JSON.stringify({ name: change.name, disabled: original === true }),
      }).catch(() => undefined)
    }
  }
}

/* ─────────────────────────────── 转发层 ─────────────────────────────── */

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > CONFIG.maxBodyBytes) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

async function proxy(request, response, url) {
  const token = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  const recordOfKey = keyByToken(token)
  if (recordOfKey === undefined) {
    return openaiError(
      response,
      401,
      'Incorrect API key provided. 请到 http://127.0.0.1:' +
        String(CONFIG.port) +
        '/ 创建一把 key。',
      'invalid_api_key',
    )
  }
  if (recordOfKey.enabled === false) {
    return openaiError(response, 403, `API key「${recordOfKey.name}」已被停用。`, 'key_disabled')
  }

  // 模型目录：只报这两个 id（都归一到同一个上游模型），客户端就不会去试别的。
  if (url.pathname === '/v1/models' && request.method === 'GET') {
    return jsonRes(response, {
      object: 'list',
      data: ['deepseek-v4.1', 'deepseek-v4.1-flash'].map((id) => ({
        id,
        object: 'model',
        created: Math.floor(Date.parse(recordOfKey.createdAt) / 1000),
        owned_by: CONFIG.channel,
      })),
    })
  }

  if (url.pathname !== '/v1/chat/completions' || request.method !== 'POST') {
    return openaiError(response, 404, `不支持的接口：${url.pathname}`, 'not_found')
  }

  const raw = await readBody(request)
  let payload
  try {
    payload = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'))
  } catch {
    return openaiError(response, 400, '请求体不是合法 JSON。', 'invalid_json')
  }

  const asked = typeof payload?.model === 'string' ? payload.model.trim() : ''
  if (asked === '') {
    return openaiError(response, 400, '缺少 model 参数。', 'missing_model', 'model')
  }
  if (!CONFIG.acceptModels.includes(asked)) {
    // 这一层只放行 workbuddy 的 deepseek-v4.1，别的模型明确拒绝 —— 不静默改写。
    return openaiError(
      response,
      404,
      `本 key 只提供 ${CONFIG.model}（workbuddy 渠道）。${asked} 不在可用列表里。`,
      'model_not_found',
      'model',
    )
  }

  // 一律改写成上游认的那个 id：`deepseek-v4.1` 这类短名也走同一条路。
  const upstreamBody = JSON.stringify({ ...payload, model: CONFIG.model })
  const startedAt = Date.now()
  const streaming = payload?.stream === true

  /**
   * 日额度闸门 —— **必须在花上游任何额度之前**判断。
   *
   * 超限回 429 + `Retry-After`（到本地午夜的秒数），错误体对齐 OpenAI 的
   * `rate_limit_error`，客户端 SDK 会当成可重试的限流而不是配置错误。
   */
  const refusal = quotaRefusal(recordOfKey)
  if (refusal !== null) {
    return send(
      response,
      429,
      {
        ...CORS,
        'content-type': 'application/json; charset=utf-8',
        'retry-after': String(secondsToMidnight()),
      },
      JSON.stringify({
        error: {
          message: refusal.message,
          type: 'rate_limit_error',
          code: 'daily_quota_exceeded',
          param: refusal.limit,
        },
      }),
    )
  }

  const scope = scopeOf(recordOfKey)

  /**
   * 限号：先把全局启用集合切成这把 key 的范围，跑完这一次请求就还原。
   *
   * ⚠️ 两个路径的**收尾必须对称**：`finally` 里还原，否则一次异常就让
   * 别的客户端看到一个被截窄的池子，而且没有任何报错。
   */
  if (scope.mode === 'selected') {
    return await withScopeLock(async () => {
      let restore
      try {
        restore = await narrowToScope(scope.accounts)
      } catch (error) {
        return openaiError(
          response,
          502,
          `切换账号范围失败：${String(error?.message ?? error)}`,
          'scope_unavailable',
        )
      }
      try {
        await forwardToUpstream()
      } finally {
        await restore()
      }
    })
  }

  return await forwardToUpstream()

  /** 真正发一次上游请求并回写（整包与流式两条路都在里面）。 */
  async function forwardToUpstream() {
    let upstreamResponse
    try {
      upstreamResponse = await fetch(`${CONFIG.upstream}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${UPSTREAM_KEY}`,
          'content-type': 'application/json',
          accept: request.headers.accept ?? '*/*',
        },
        body: upstreamBody,
      })
    } catch (error) {
      record({
        ts: new Date().toISOString(),
        keyId: recordOfKey.id,
        keyName: recordOfKey.name,
        model: CONFIG.model,
        status: 599,
        stream: streaming,
        error: String(error?.message ?? error),
        ms: Date.now() - startedAt,
      })
      return openaiError(
        response,
        502,
        `上游不可达：${String(error?.message ?? error)}`,
        'upstream_unreachable',
      )
    }

    const traceId = upstreamResponse.headers.get('x-cpa-trace-id') ?? undefined
    const account = accountOfTrace(traceId)
    const contentType = upstreamResponse.headers.get('content-type') ?? 'application/json'
    /** 客户端地址：判断「手机的请求到底有没有到」时，这一格比任何日志都直接。 */
    const clientIp = (
      request.headers['cf-connecting-ip'] ??
      request.headers['x-forwarded-for'] ??
      request.socket.remoteAddress ??
      ''
    )
      .toString()
      .split(',')[0]
      .trim()

    /** 无论流式还是整包，收尾时都写一行账**并**累加当日计数。 */
    const finish = (text, error) => {
      const usage = lastUsageObject(text) ?? {}
      const credit = Number(usage.credit ?? 0)
      recordOfKey.lastUsedAt = new Date().toISOString()
      saveKeys()
      record({
        ts: recordOfKey.lastUsedAt,
        keyId: recordOfKey.id,
        keyName: recordOfKey.name,
        model: CONFIG.model,
        status: upstreamResponse.status,
        stream: streaming,
        promptTokens: Number(usage.prompt_tokens ?? 0),
        completionTokens: Number(usage.completion_tokens ?? 0),
        totalTokens: Number(usage.total_tokens ?? 0),
        credit,
        account,
        clientIp,
        requestId: traceId,
        ...(error === undefined ? {} : { error }),
        ms: Date.now() - startedAt,
      })
      // ⚠️ 只有真正打到上游才计数：401 / 404 / 429 不该吃掉今天的额度。
      bumpDayUsage(recordOfKey.id, credit)
    }

    if (contentType.includes('text/event-stream')) {
      response.writeHead(upstreamResponse.status, {
        ...CORS,
        'content-type': contentType,
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...(traceId === undefined ? {} : { 'x-cpa-trace-id': traceId }),
        // ⚠️ 只放 UUID，不放 key 名字 —— HTTP 头只能是 ASCII，中文名字会让 writeHead 抛错。
        'x-pool-key-id': recordOfKey.id,
      })
      let seen = ''
      try {
        for await (const chunk of upstreamResponse.body) {
          response.write(chunk)
          // ⚠️ `chunk` 是 Uint8Array，直接 `.toString('utf8')` 会得到 "104,101,…" 这种逗号串
          //    （Uint8Array.toString 不接受编码参数）—— 必须先过 Buffer 再解码。
          const text = Buffer.from(chunk).toString('utf8')
          // 只留最后 256 KB 用来找 usage，避免长流把内存吃满。
          if (seen.length < 262144) seen += text
          else seen = seen.slice(-131072) + text
        }
        response.end()
        finish(seen)
      } catch (error) {
        response.end()
        finish(seen, String(error?.message ?? error))
      }
      return
    }

    const text = await upstreamResponse.text()
    response.writeHead(upstreamResponse.status, {
      ...CORS,
      'content-type': contentType,
      ...(traceId === undefined ? {} : { 'x-cpa-trace-id': traceId }),
      // ⚠️ 只放 UUID，不放 key 名字 —— HTTP 头只能是 ASCII，中文名字会让 writeHead 抛错。
      'x-pool-key-id': recordOfKey.id,
    })
    response.end(text)
    finish(text)
  }
}

/* ─────────────────────────────── 管理 API ─────────────────────────────── */

function usageSummary(rows, keyId) {
  const filtered = keyId === undefined || keyId === 'all' ? rows : rows.filter((r) => r.keyId === keyId)
  const perKey = new Map()
  for (const row of filtered) {
    const bucket =
      perKey.get(row.keyId) ??
      {
        keyId: row.keyId,
        keyName: row.keyName,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        credit: 0,
        lastAt: null,
        accounts: new Map(),
        errors: 0,
      }
    bucket.requests += 1
    bucket.promptTokens += Number(row.promptTokens ?? 0)
    bucket.completionTokens += Number(row.completionTokens ?? 0)
    bucket.credit += Number(row.credit ?? 0)
    if (row.ts !== undefined && (bucket.lastAt === null || row.ts > bucket.lastAt)) bucket.lastAt = row.ts
    if (row.account !== undefined) {
      bucket.accounts.set(row.account, (bucket.accounts.get(row.account) ?? 0) + 1)
    }
    if (Number(row.status) >= 400) bucket.errors += 1
    perKey.set(row.keyId, bucket)
  }
  return [...perKey.values()]
    .map((bucket) => ({
      ...bucket,
      accounts: [...bucket.accounts.entries()]
        .map(([authIndex, count]) => ({ authIndex, count }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => String(b.lastAt ?? '').localeCompare(String(a.lastAt ?? '')))
}

async function adminApi(request, response, url) {
  const pathname = url.pathname

  /* ── 账号 ── */

  if (pathname === '/admin/api/accounts' && request.method === 'GET') {
    return jsonRes(response, await listAccounts())
  }

  const accountMatch = /^\/admin\/api\/accounts\/([0-9a-f]+)\/enabled$/.exec(pathname)
  if (accountMatch !== null && request.method === 'POST') {
    const body = parseJsonText(await safeJson(request), {})
    const listed = await listAccounts()
    if (listed.ok !== true) return jsonRes(response, listed, 500)
    const target = listed.accounts.find((account) => account.authIndex === accountMatch[1])
    if (target === undefined) return jsonRes(response, { ok: false, error: 'not-found' }, 404)
    if (target.fileName === null) {
      return jsonRes(response, { ok: false, error: 'no-credential-file' }, 409)
    }
    try {
      await cpaAdmin('/v0/management/auth-files/status', {
        method: 'PATCH',
        body: JSON.stringify({ name: target.fileName, disabled: body.enabled !== true }),
      })
      poolCache = { at: 0, value: undefined }
      return jsonRes(response, { ok: true })
    } catch (error) {
      return jsonRes(response, { ok: false, error: String(error?.message ?? error) }, 502)
    }
  }

  /* ── 登录（起一次 WorkBuddy 授权） ── */

  if (pathname === '/admin/api/login' && request.method === 'POST') {
    try {
      const data = await cpaAdmin(
        `/v8/management/oauth/auth-url?provider=${encodeURIComponent(CONFIG.channel)}`,
      )
      if (typeof data?.url !== 'string' || data.url === '') {
        return jsonRes(response, { ok: false, error: String(data?.error ?? 'no-auth-url') }, 502)
      }
      loginSessions.set(String(data.state), { url: data.url, startedAt: Date.now() })
      return jsonRes(response, { ok: true, state: data.state, url: data.url })
    } catch (error) {
      return jsonRes(response, { ok: false, error: String(error?.message ?? error) }, 502)
    }
  }

  if (pathname === '/admin/api/login/status' && request.method === 'GET') {
    const state = url.searchParams.get('state') ?? ''
    if (state === '') return jsonRes(response, { ok: false, error: 'missing-state' }, 400)
    try {
      const data = await cpaAdmin(`/v8/management/oauth/status?state=${encodeURIComponent(state)}`)
      const status = String(data?.status ?? 'unknown')
      /**
       * ⚠️ `wait` = 还在等授权；其余取值都表示这次会话结束了。
       * 结束就清缓存：新号已经落盘，余额与账号列表都变了。
       */
      if (status !== 'wait') {
        loginSessions.delete(state)
        poolCache = { at: 0, value: undefined }
      }
      return jsonRes(response, { ok: true, status })
    } catch (error) {
      return jsonRes(response, { ok: false, error: String(error?.message ?? error) }, 502)
    }
  }

  if (pathname === '/admin/api/login/cancel' && request.method === 'POST') {
    const body = parseJsonText(await safeJson(request), {})
    const state = String(body.state ?? '')
    if (state === '') return jsonRes(response, { ok: false, error: 'missing-state' }, 400)
    try {
      await cpaAdmin(`/v8/management/oauth/session?state=${encodeURIComponent(state)}`, {
        method: 'DELETE',
      })
      loginSessions.delete(state)
      return jsonRes(response, { ok: true })
    } catch (error) {
      return jsonRes(response, { ok: false, error: String(error?.message ?? error) }, 502)
    }
  }

  if (pathname === '/admin/api/state' && request.method === 'GET') {
    const usage = readUsage()
    const summary = usageSummary(usage)
    const byKey = new Map(summary.map((row) => [row.keyId, row]))
    const pool = await readPool()
    const nicknames =
      pool.ok === true ? new Map(pool.accounts.map((a) => [a.authIndex, a.nickname])) : new Map()
    const nicknameOf = (authIndex) => nicknames.get(authIndex) ?? authIndex
    return jsonRes(response, {
      ok: true,
      models: ['deepseek-v4.1', 'deepseek-v4.1-flash'],
      channel: CONFIG.channel,
      pool,
      keys: store.keys.map((item) => {
        const stat = byKey.get(item.id)
        const scope = scopeOf(item)
        return {
          id: item.id,
          name: item.name,
          keyMasked: maskOf(item.key),
          trackingId: item.trackingId,
          createdAt: item.createdAt,
          lastUsedAt: stat?.lastAt ?? item.lastUsedAt,
          enabled: item.enabled !== false,
          requests: stat?.requests ?? 0,
          credit: stat?.credit ?? 0,
          today: todayOf(item.id),
          quota: quotaOf(item),
          scope: {
            mode: scope.mode,
            accounts: scope.accounts.map((authIndex) => ({
              authIndex,
              nickname: nicknameOf(authIndex),
            })),
          },
          accounts: (stat?.accounts ?? []).map((a) => ({
            authIndex: a.authIndex,
            nickname: nicknameOf(a.authIndex),
            count: a.count,
          })),
        }
      }),
    })
  }

  if (pathname === '/admin/api/usage' && request.method === 'GET') {
    const keyId = url.searchParams.get('keyId') ?? 'all'
    const pool = await readPool()
    const accounts = pool.ok === true ? new Map(pool.accounts.map((a) => [a.authIndex, a.nickname])) : new Map()
    const rows = usageSummary(readUsage(), keyId).map((row) => ({
      ...row,
      accounts: row.accounts.map((a) => ({ ...a, nickname: accounts.get(a.authIndex) ?? a.authIndex })),
    }))
    return jsonRes(response, { ok: true, rows })
  }

  if (pathname === '/admin/api/keys' && request.method === 'POST') {
    const body = parseJsonText(await safeJson(request), {})
    const created = newKeyRecord(body)
    store.keys.unshift(created)
    saveKeys()
    return jsonRes(response, { ok: true, key: created })
  }

  const match = /^\/admin\/api\/keys\/([0-9a-f-]+)(\/reveal)?$/.exec(pathname)
  if (match !== null) {
    const target = store.keys.find((item) => item.id === match[1])
    if (target === undefined) return jsonRes(response, { ok: false, error: 'not-found' }, 404)

    if (match[2] === '/reveal' && request.method === 'POST') {
      return jsonRes(response, { ok: true, key: target.key })
    }
    if (request.method === 'PATCH') {
      const body = parseJsonText(await safeJson(request), {})
      if (typeof body.name === 'string' && body.name.trim() !== '') {
        target.name = body.name.trim().slice(0, 60)
      }
      if (typeof body.enabled === 'boolean') target.enabled = body.enabled
      /** `quota` / `scope` 只有显式传了才改 —— 改个名字不该顺手清掉限额。 */
      if (body.quota !== undefined) target.quota = normalizeQuota(body.quota)
      if (body.scope !== undefined) target.scope = normalizeScope(body.scope)
      saveKeys()
      return jsonRes(response, { ok: true })
    }
    if (request.method === 'DELETE') {
      store.keys = store.keys.filter((item) => item.id !== target.id)
      dayUsage.delete(target.id)
      saveKeys()
      return jsonRes(response, { ok: true })
    }
  }

  return jsonRes(response, { ok: false, error: 'not-found' }, 404)
}

function safeJson(request) {
  return new Promise((resolve) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', () => resolve(''))
  })
}

/* ──────────────────────────────── 管理页 ──────────────────────────────── */

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>API Keys · workbuddy 积分池</title>
<style>
  :root{--bg:#fff;--panel:#f4f5f7;--line:#e7e8ea;--ink:#16181d;--muted:#8b8f98;--accent:#2f6fed}
  *{box-sizing:border-box}
  body{margin:0;padding:40px 44px 64px;background:var(--bg);color:var(--ink);
       font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .top{display:flex;justify-content:flex-end;gap:12px;margin-bottom:18px}
  .tabs{display:flex;gap:22px;margin:0 4px 14px;border-bottom:1px solid var(--line)}
  .tab{padding:0 2px 10px;cursor:pointer;color:var(--muted);font-size:14px;border-bottom:2px solid transparent}
  .tab.active{color:var(--ink);border-bottom-color:var(--ink)}
  .sw{position:relative;display:inline-block;width:38px;height:22px}
  .sw input{opacity:0;width:0;height:0}
  .sw span{position:absolute;inset:0;background:#d9dbe0;border-radius:999px;transition:.15s}
  .sw span:before{content:"";position:absolute;width:16px;height:16px;left:3px;top:3px;
                 background:#fff;border-radius:50%;transition:.15s}
  .sw input:checked+span{background:#2f6fed}
  .sw input:checked+span:before{transform:translateX(16px)}
  button{font:inherit;cursor:pointer;border-radius:999px;border:1px solid var(--line);
         background:#fff;color:var(--ink);padding:9px 18px;transition:.15s}
  button:hover{border-color:#cfd2d8}
  button.primary{background:#17191d;border-color:#17191d;color:#fff}
  button.primary:hover{background:#000}
  .pool{display:flex;gap:26px;align-items:baseline;margin:0 4px 16px;color:var(--muted);font-size:13px}
  .pool b{color:var(--ink);font-size:15px;font-weight:600}
  .panel{background:var(--panel);border-radius:14px;overflow:hidden}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:16px 18px;font-weight:400;vertical-align:middle}
  th{color:var(--muted);font-size:13px;font-weight:400}
  tbody tr{background:var(--panel)}
  tbody tr+tr td{border-top:1px solid var(--line)}
  .name{display:flex;align-items:center;gap:8px}
  .badge{font-size:11px;color:#2f6fed;background:#eaf0ff;border-radius:4px;padding:1px 6px;white-space:nowrap}
  .mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;color:#3b3f47}
  .muted{color:var(--muted)}
  .ops{display:flex;gap:16px;justify-content:flex-end;color:#b9bcc3;font-size:15px}
  .ops span{cursor:pointer}
  .ops span:hover{color:var(--ink)}
  .empty{padding:28px 18px;color:var(--muted);text-align:center}
  .drawer{margin-top:26px}
  .drawer h3{font-size:14px;font-weight:600;margin:0 4px 12px}
  .reveal{margin-top:16px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px}
  .reveal code{font-family:ui-monospace,Consolas,monospace;font-size:13px;word-break:break-all}
  .hint{color:var(--muted);font-size:12.5px;margin-top:8px}
</style></head><body>
<div class="tabs">
  <span class="tab active" data-tab="keys">API Keys</span>
  <span class="tab" data-tab="accounts">账号</span>
</div>
<div class="top">
  <button id="usageBtn">按 API Key 查看用量</button>
  <button id="loginBtn" hidden>登录 WorkBuddy 账号</button>
  <button class="primary" id="createBtn">创建 API key</button>
</div>
<div class="pool" id="pool"><span>读取池子…</span></div>

<div id="tab-keys">
  <div class="panel">
    <table>
      <thead><tr>
        <th style="width:26%">名称</th><th style="width:24%">Tracking ID</th>
        <th style="width:20%">Key</th><th style="width:14%">创建日期</th>
        <th style="width:16%">最新使用日期</th><th></th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div class="drawer" id="drawer" hidden>
    <h3>按 API Key 查看用量</h3>
    <div class="panel"><table>
      <thead><tr><th>名称</th><th>请求数</th><th>输入 tokens</th><th>输出 tokens</th>
        <th>积分</th><th>最近使用</th><th>落在哪些号</th></tr></thead>
      <tbody id="usageRows"></tbody>
    </table></div>
  </div>
</div>

<div id="tab-accounts" hidden>
  <div class="panel">
    <table>
      <thead><tr>
        <th style="width:30%">账号</th><th>剩余</th><th>已用</th><th>额度池</th>
        <th>状态</th><th style="width:12%">参与调度</th>
      </tr></thead>
      <tbody id="accountRows"></tbody>
    </table>
  </div>
  <div class="hint" style="margin-top:14px">
    这些号共用同一个 key 池：**启用的号**才会被调度到，停用的号完全不参与。
    每次调用记一行账，能在「按 API Key 查看用量」里看到落在哪个号上。
  </div>
</div>

<div id="loginBox" class="reveal" hidden></div>
<div id="reveal" class="reveal" hidden></div>
<div class="hint" style="margin-top:22px">
  这一层只放行 <span class="mono" id="modelName"></span>；其余模型一律 404。
  <br/>本机（电脑上）Base URL：<span class="mono" id="baseUrl"></span>
  <br/>手机同一 Wi-Fi 用这个：<span class="mono">__LAN_HINT__</span>（路径 <span class="mono">/v1</span>）
</div>
<script>
const short = (id) => id.slice(0,8) + ' … ' + id.slice(-12)
const day = (iso) => iso ? new Date(iso).toLocaleDateString('sv-SE') : '—'
const num = (n) => (typeof n === 'number' ? n.toLocaleString() : '—')

async function api(path, init) {
  const r = await fetch(path, init)
  return await r.json()
}

/* ── 页签 ── */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab))
    const name = tab.dataset.tab
    document.getElementById('tab-keys').hidden = name !== 'keys'
    document.getElementById('tab-accounts').hidden = name !== 'accounts'
    document.getElementById('createBtn').hidden = name !== 'keys'
    document.getElementById('usageBtn').hidden = name !== 'keys'
    document.getElementById('loginBtn').hidden = name !== 'accounts'
    if (name === 'accounts') refreshAccounts()
  }
})

async function refresh() {
  const s = await api('/admin/api/state')
  document.getElementById('modelName').textContent = s.models[0]
  document.getElementById('baseUrl').textContent = location.origin + '/v1'
  const pool = s.pool
  document.getElementById('pool').innerHTML = pool.ok
    ? '<span>池子剩余 <b>' + pool.remain.toLocaleString() + '</b> 积分</span>' +
      '<span>已用 <b>' + pool.used.toLocaleString() + '</b></span>' +
      '<span>账号 <b>' + pool.accountCount + '</b> 个</span>' +
      '<span>模型 <b>' + pool.model + '</b></span>'
    : '<span>池子读不到：' + (pool.error ?? '未知') + '</span>'

  const rows = document.getElementById('rows')
  if (s.keys.length === 0) {
    rows.innerHTML = '<tr><td colspan="6" class="empty">还没有 key —— 点右上角「创建 API key」</td></tr>'
    return
  }
  rows.innerHTML = s.keys.map((k) => \`
    <tr>
      <td><div class="name"><span>\${k.name}</span><span class="badge">Pool-managed</span></div>
        \${k.enabled ? '' : '<span class="muted" style="font-size:12px">（已停用）</span>'}</td>
      <td class="mono muted" title="\${k.trackingId}">\${short(k.trackingId)}</td>
      <td class="mono" data-key="\${k.id}" title="点击显示">\${k.keyMasked}</td>
      <td class="muted">\${day(k.createdAt)}</td>
      <td class="muted">\${day(k.lastUsedAt)}</td>
      <td><div class="ops">
        <span data-act="reveal" data-id="\${k.id}" title="显示完整 key">✎</span>
        <span data-act="delete" data-id="\${k.id}" title="删除">🗑</span>
      </div></td>
    </tr>\`).join('')
}

async function refreshAccounts() {
  const out = await api('/admin/api/accounts')
  const body = document.getElementById('accountRows')
  if (out.ok !== true) {
    body.innerHTML = '<tr><td colspan="6" class="empty">读不到账号：' + (out.error ?? '未知') + '</td></tr>'
    return
  }
  if (out.accounts.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty">还没有账号 —— 点「登录 WorkBuddy 账号」</td></tr>'
    return
  }
  body.innerHTML = out.accounts.map((a) => \`
    <tr>
      <td><div class="name"><span>\${a.nickname}</span>
        <span class="mono muted" style="font-size:11px">\${a.authIndex}</span></div></td>
      <td>\${num(a.credits?.remain)}</td>
      <td class="muted">\${num(a.credits?.used)}</td>
      <td class="muted">\${num(a.credits?.size)}</td>
      <td class="muted">\${a.exhausted ? '已耗尽' : (a.status ?? '—')}</td>
      <td><label class="sw"><input type="checkbox" \${a.disabled ? '' : 'checked'}
        data-index="\${a.authIndex}"/><span></span></label></td>
    </tr>\`).join('')
}

document.getElementById('accountRows').onchange = async (event) => {
  const box = event.target.closest('input[data-index]')
  if (box === null) return
  const index = box.dataset.index
  const out = await api('/admin/api/accounts/' + index + '/enabled', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: box.checked }),
  })
  if (out.ok !== true) { alert('改不动：' + (out.error ?? '未知')); }
  await refreshAccounts()
  await refresh()
}

/* ── 登录一个新账号 ── */
let loginTimer = null
document.getElementById('loginBtn').onclick = async () => {
  const out = await api('/admin/api/login', { method: 'POST' })
  const box = document.getElementById('loginBox')
  box.hidden = false
  if (out.ok !== true) {
    box.innerHTML = '<div class="hint">起不来登录：' + (out.error ?? '未知') + '</div>'
    return
  }
  box.innerHTML = '<div class="hint">在浏览器里打开这个地址完成授权（手机也能扫码打开）：</div>' +
    '<code>' + out.url + '</code>' +
    '<div class="hint" id="loginState">等待授权…</div>'
  if (loginTimer !== null) clearInterval(loginTimer)
  loginTimer = setInterval(async () => {
    const st = await api('/admin/api/login/status?state=' + encodeURIComponent(out.state))
    const label = document.getElementById('loginState')
    if (label === null) { clearInterval(loginTimer); return }
    if (st.ok !== true) { label.textContent = '查不到进度：' + (st.error ?? ''); clearInterval(loginTimer); return }
    label.textContent = st.status === 'wait' ? '等待授权…' : '授权结束（' + st.status + '）'
    if (st.status !== 'wait') {
      clearInterval(loginTimer)
      loginTimer = null
      await refreshAccounts()
      await refresh()
    }
  }, 2000)
}

document.getElementById('createBtn').onclick = async () => {
  const name = prompt('给这把 key 起个名字（例如：自己的脚本、朋友的笔记本）')
  if (name === null) return
  const out = await api('/admin/api/keys', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  showReveal(out.key.key, '仅显示这一次，请立刻复制保存')
  await refresh()
}

document.getElementById('usageBtn').onclick = async () => {
  const drawer = document.getElementById('drawer')
  drawer.hidden = !drawer.hidden
  if (drawer.hidden) return
  const out = await api('/admin/api/usage?keyId=all')
  const body = document.getElementById('usageRows')
  body.innerHTML = out.rows.length === 0
    ? '<tr><td colspan="7" class="empty">还没有调用记录</td></tr>'
    : out.rows.map((r) => \`
      <tr><td>\${r.keyName}</td><td>\${r.requests}</td><td>\${r.promptTokens}</td>
        <td>\${r.completionTokens}</td><td>\${r.credit}</td><td class="muted">\${day(r.lastAt)}</td>
        <td class="mono muted">\${r.accounts.map((a) => a.nickname + '×' + a.count).join('、') || '—'}</td></tr>\`).join('')
}

document.getElementById('rows').onclick = async (event) => {
  const target = event.target.closest('span[data-act]')
  if (target === null) return
  const id = target.dataset.id
  if (target.dataset.act === 'delete') {
    if (!confirm('删除后这把 key 立刻失效，确认？')) return
    await api('/admin/api/keys/' + id, { method: 'DELETE' })
  } else {
    const out = await api('/admin/api/keys/' + id + '/reveal', { method: 'POST' })
    showReveal(out.key, '这把 key 的完整值')
  }
  await refresh()
}

function showReveal(key, note) {
  const box = document.getElementById('reveal')
  box.hidden = false
  box.innerHTML = '<div class="hint">' + note + '</div><code>' + key + '</code>'
}

refresh()
</script></body></html>`

/* ──────────────────────────────── 启动 ──────────────────────────────── */

/** 这台机器在局域网里的地址 —— 手机要填的就是它，不是 127.0.0.1。 */
function lanAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      if (item.address.startsWith('169.254.')) continue
      out.push(item.address)
    }
  }
  return out
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  const route = async () => {
    // 预检请求：手机端 / 网页端跨源都会先发 OPTIONS，回空了就行。
    if (request.method === 'OPTIONS') {
      return send(response, 204, {}, '')
    }
    if (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/admin/') {
      const lan = lanAddresses()
      const hint =
        lan.length === 0
          ? '没有检测到局域网地址'
          : lan.map((ip) => `http://${ip}:${String(CONFIG.port)}`).join(' 或 ')
      return send(
        response,
        200,
        { 'content-type': 'text/html; charset=utf-8' },
        PAGE.replace('__LAN_HINT__', hint),
      )
    }
    if (url.pathname === '/healthz') {
      return jsonRes(response, {
        ok: true,
        model: CONFIG.model,
        channel: CONFIG.channel,
        upstream: CONFIG.upstream,
        upstreamKey: UPSTREAM_KEY === '' ? 'missing' : 'ok',
        adminKey: ADMIN_KEY === '' ? 'missing' : 'ok',
        keys: store.keys.length,
      })
    }
    if (url.pathname.startsWith('/admin/api/')) return await adminApi(request, response, url)
    return await proxy(request, response, url)
  }
  route().catch((error) => {
    if (!response.headersSent) {
      openaiError(response, 500, String(error?.message ?? error), 'internal_error')
    } else {
      response.end()
    }
  })
})

/** 启动时回放当天账本，否则每次重启当日额度就被清空（限额形同虚设）。 */
seedDayUsage()

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`BuddyKey listening on http://${CONFIG.host}:${CONFIG.port}`)
  console.log(`  管理页   http://${CONFIG.host}:${CONFIG.port}/`)
  console.log(`  允许模型 ${CONFIG.model}（渠道 ${CONFIG.channel}）`)
  console.log(`  上游     ${CONFIG.upstream}   key=${UPSTREAM_KEY === '' ? '缺失' : '已取到'}`)
  console.log(`  管理 key ${ADMIN_KEY === '' ? '缺失（池子余额不显示）' : '已取到'}`)
  console.log(`  数据目录 ${DATA_DIR}`)
})

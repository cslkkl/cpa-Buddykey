/**
 * BuddyKey —— 登录 WorkBuddy 账号，把账号池做成「像控制台那样的具名 API Key」。
 *
 * 为什么需要这一层：CPA 自己的 `access.api-keys` 只是一串裸字符串
 * （实测 `{"api-keys":["sk-cpa-example"]}`），没有名字、没有 Tracking ID、
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
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PAGE } from './lib/ui.mjs'
import { resolveSourceKey } from './lib/update-text.mjs'
import { checkUpdate, installSource } from './tools/upstream.mjs'

/**
 * 页面要用的 `updateView` / `updateResultLine`，从 `lib/update-text.mjs` 现读、现注入。
 *
 * 为什么注入源码而不是在页面里再写一份：那两个判定（「没记录 ≠ 有新版」
 * 「查不到 ≠ 已是最新」）一旦分叉，页面就会替后端撒谎。参考实现把这段
 * 单独拆成 `update-text.ts` 正是为了只留一份；这里条件更差（页面是 inline script，
 * 不是模块），所以退回「读同一个文件、剥掉 export 关键字、内联」——
 * 仍然是**同一份**实现。
 *
 * ⚠️ 前提：那个文件必须**没有 import**、且只用 `export` 前缀声明。
 *   它现在符合；若哪天加了依赖，这里会注入出一段语法错误的脚本，
 *   页面直接白屏 —— 所以下面检查一次，不合格就不注入。
 */
const UPDATE_TEXT_BROWSER = (() => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'update-text.mjs')
  let source = ''
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch {
    return '/* 读不到 lib/update-text.mjs，页面不显示上游版本那一行 */'
  }
  if (/^\s*import\s/m.test(source) === true) {
    console.log('  ⚠️ lib/update-text.mjs 有 import，跳过内联；页面上游版本那一行不可用。')
    return '/* update-text 含 import，未内联 */'
  }
  /** 注释里的 {@link …} 与 markdown 链接对 JS 无害，只要剥掉 export 就能当普通脚本跑。 */
  return source.replace(/^export\s+/gm, '')
})()

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
  /** 两个 CPA 密钥从哪来，见 `resolveSecret` 的三级回退。 */
  upstreamKey: '',
  adminKey: '',
  upstreamKeyEnv: 'BUDDYKEY_UPSTREAM_KEY',
  adminKeyEnv: 'BUDDYKEY_ADMIN_KEY',
  /** 旧路径：`~/.dsh/.credentials.yaml` 的 refs 段。留空 = 不读那个文件。 */
  credentialsFile: '',
  upstreamKeyRef: 'CPA_API_KEY',
  adminKeyRef: 'CPA_ADMIN_KEY',
  /** 这一层锁死的渠道与模型。 */
  channel: 'workbuddy',
  /**
   * 管理接口的口令。
   *
   * ⚠️ 空着只在**只绑本机**时允许。`/admin/api/*` 能读账号池、能建 key、能发起登录 ——
   *   一旦绑到 0.0.0.0 又不设口令，任何能扫到这个端口的人都能给自己发一把 key
   *   白嫖你的额度（实测确认过：无凭据 POST /admin/api/keys 直接 200 返回可用 key）。
   *   所以启动时会检查：**非回环地址 + 空口令 = 拒绝启动**，宁可起不来也不裸奔。
   */
  adminPassword: '',
  /**
   * 上游模型 id。
   *
   * ⚠️ 留空 = **启动时从 CPA 现探**（推荐）。别写死。
   *   同一份插件不同版本的前缀会变：v0.9.x 是 `wb/deepseek-v4.1-flash`，
   *   v0.10.0 变成 `cn/deepseek-v4.1-flash`（国际版还会是别的）。
   *   写死会导致「装完什么都对、一调就 400 unknown provider」——
   *   报错信息还指向 model 而不是插件版本，极难查（踩过）。
   *   填了值就当用户明确指定，不再探测。
   */
  model: '',
  /** 对外暴露的模型别名。`__AUTO__` = 由探测结果生成，见 `resolveModels`。 */
  acceptModels: [],
  /** 探测失败时的兜底，按优先级排。 */
  modelFallback: [
    'cn/deepseek-v4.1-flash',
    'wb/deepseek-v4.1-flash',
    'cn/deepseek-v4-flash',
    'wb/deepseek-v4-flash',
  ],
  maxBodyBytes: 32 * 1024 * 1024,
}

const CONFIG = { ...DEFAULTS, ...readJson(CONFIG_FILE, {}) }
const CREDS = readCredentialRefs()
const UPSTREAM = resolveSecret({
  direct: CONFIG.upstreamKey,
  envName: CONFIG.upstreamKeyEnv,
  refName: CONFIG.upstreamKeyRef,
})
const ADMIN = resolveSecret({
  direct: CONFIG.adminKey,
  envName: CONFIG.adminKeyEnv,
  refName: CONFIG.adminKeyRef,
})
const UPSTREAM_KEY = UPSTREAM.value
const ADMIN_KEY = ADMIN.value

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

/**
 * 从 `~/.dsh/.credentials.yaml` 的 `refs:` 段取凭据（只取用得到的几个）。
 *
 * ⚠️ 这是**旧路径**，只为兼容「这台机器上装着 dsh-cpa-switch」的场景。
 *   别人拉这个仓库时没有那个文件，函数会安静地返回 `{}`，
 *   于是 `resolveSecret` 落到 `none` —— 管理页会直接告诉你缺什么，而不是装作配好了。
 *
 * `config.credentialsFile` 留空 = 用默认路径 `~/.dsh/.credentials.yaml`；
 * 填了就只读那一个，方便把这层挪到别处。
 */
function readCredentialRefs() {
  const configured =
    typeof CONFIG.credentialsFile === 'string' && CONFIG.credentialsFile.trim() !== ''
      ? CONFIG.credentialsFile.trim()
      : path.join(os.homedir(), '.dsh', '.credentials.yaml')
  try {
    if (!fs.existsSync(configured)) return {}
    const text = fs.readFileSync(configured, 'utf8')
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

/**
 * 一个密钥的三级来源，先到先得：
 *
 *   1. `config.json` 直写（`upstreamKey` / `adminKey`）—— 最直白，推荐给「别人」；
 *   2. 环境变量（`BUDDYKEY_UPSTREAM_KEY` / `BUDDYKEY_ADMIN_KEY`）—— 适合容器与 CI；
 *   3. `~/.dsh/.credentials.yaml` 的 refs 段 —— 本机旧路径，保持兼容。
 *
 * 返回 `{ value, source }`，`source` 会原样出现在 `/healthz` 与管理页上，
 * 这样「配了没生效」和「压根没配」能一眼分开，不必去翻代码猜。
 */
function resolveSecret({ direct, envName, refName }) {
  const clean = (value) => (typeof value === 'string' ? value.trim() : '')
  const fromConfig = clean(direct)
  if (fromConfig !== '') return { value: fromConfig, source: 'config' }
  const fromEnv = clean(process.env[envName])
  if (fromEnv !== '') return { value: fromEnv, source: 'env' }
  const fromRefs = clean(CREDS[refName])
  if (fromRefs !== '') return { value: fromRefs, source: 'refs' }
  return { value: '', source: 'none' }
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

/* ─────────────────────────── 模型解析 ─────────────────────────── */

/**
 * 这一层对外只暴露一个模型，但它的**上游 id**必须跟插件的版本走。
 *
 * 见过的两代前缀：
 *   - workbuddy.dll v0.9.x（腾讯 CN 版）→ `wb/deepseek-v4.1-flash`
 *   - CodeBuddy Intl CPA v0.10.0      → `cn/deepseek-v4.1-flash`（国际版还有别的区）
 * 插件升级换前缀是常事，所以默认在启动时问一次 CPA `/v1/models`，
 * 按「候选优先级」挑一个真实存在的；探测不到才落回 `modelFallback`。
 *
 * 对外的别名集合也跟着探测结果生成 —— 客户端填 `deepseek-v4.1-flash`、
 * `deepseek-v4.1`、或者上游全名都能用，全部归一到同一个上游 id。
 */
const MODEL_STATE = {
  /** 最终用的上游模型 id。 */
  upstream: '',
  /** 客户端可以填的别名（含 `upstream` 本身）。 */
  accept: [],
  /** `probe` = 从 CPA 探到的；`config` = 用户写死的；`fallback` = 都没成才用的兜底。 */
  source: 'fallback',
  /** 探测时看到的候选，排好序；`/healthz` 会带上，排查版本问题用。 */
  candidates: [],
}

function shortAliasesOf(upstreamModel) {
  /** `cn/deepseek-v4.1-flash` → `deepseek-v4.1-flash`、`deepseek-v4.1` */
  const bare = upstreamModel.includes('/') ? upstreamModel.split('/').slice(1).join('/') : upstreamModel
  const out = [upstreamModel, bare]
  /** 去掉 `-flash` 也留一个：客户端文档里常写短名。 */
  if (bare.endsWith('-flash')) out.push(bare.slice(0, -'-flash'.length))
  return [...new Set(out.filter((item) => item !== ''))]
}

/** 从候选里挑第一个真实存在的；都不在就取第一个（上游会自己报错，比静默降级好）。 */
function resolveModels(availableIds) {
  if (CONFIG.model !== '') {
    MODEL_STATE.upstream = CONFIG.model
    MODEL_STATE.accept = CONFIG.acceptModels.length > 0 ? [...CONFIG.acceptModels] : shortAliasesOf(CONFIG.model)
    if (!MODEL_STATE.accept.includes(CONFIG.model)) MODEL_STATE.accept.unshift(CONFIG.model)
    MODEL_STATE.source = 'config'
    return
  }

  const ids = Array.isArray(availableIds) ? availableIds : []
  MODEL_STATE.candidates = ids.filter((id) => typeof id === 'string' && id !== '')

  const wanted = CONFIG.modelFallback.filter((id) => typeof id === 'string' && id !== '')
  const hit = wanted.find((candidate) => ids.includes(candidate))
  if (hit !== undefined) {
    MODEL_STATE.upstream = hit
    MODEL_STATE.accept = shortAliasesOf(hit)
    MODEL_STATE.source = 'probe'
    return
  }

  /**
   * 兜底优先级没命中：看看有没有「deepseek-v4.1-flash」结尾的，
   * 有就说明插件换了前缀，用真实存在的那个比硬用兜底更可能直接可用。
   */
  const byShape = ids.find((id) => /deepseek-v4\.1-flash$/.test(id)) ?? ids.find((id) => /deepseek-v4.*flash$/.test(id))
  if (byShape !== undefined) {
    MODEL_STATE.upstream = byShape
    MODEL_STATE.accept = shortAliasesOf(byShape)
    MODEL_STATE.source = 'probe'
    return
  }

  /** 一个都没探到（CPA 没起 / 没登录）：先按兜底走，等 `/admin/api/health` 再探。 */
  const fallback = wanted[0] ?? 'cn/deepseek-v4.1-flash'
  MODEL_STATE.upstream = fallback
  MODEL_STATE.accept = shortAliasesOf(fallback)
  MODEL_STATE.source = 'fallback'
}

/**
 * 启动时问一次 CPA 有哪些模型。
 *
 * 失败不抛 —— 这一步是为了「少一次配置」而不是前提条件；
 * CPA 没起的时候服务照样要能起来，页面会告诉你上游不通。
 */
async function probeModelCatalog() {
  if (UPSTREAM_KEY === '') {
    resolveModels([])
    return
  }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const response = await fetch(`${CONFIG.upstream}/v1/models`, {
      headers: { authorization: `Bearer ${UPSTREAM_KEY}` },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (response.ok !== true) {
      resolveModels([])
      return
    }
    const body = await response.json().catch(() => null)
    const ids = Array.isArray(body?.data) ? body.data.map((item) => item?.id).filter((id) => typeof id === 'string') : []
    resolveModels(ids)
  } catch {
    resolveModels([])
  }
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

/**
 * CPA 的 IP 级封禁：连续输错管理密钥会触发
 * `403 {"error":"IP banned due to too many failed attempts. Try again in 29m41s"}`。
 *
 * 这是**陌生人第一次配错密钥最可能撞上**的东西，而原始 JSON 看起来像程序坏了。
 * 所以这里把它翻译成能照做的中文，并带上剩余等待时间。
 * 顺带把 `no-admin-key` 也在这里统一成人话 —— 两个原因完全不同的失败，
 * 在页面上不该长得一样。
 */
function explainUpstreamError(raw) {
  const text = String(raw ?? '')
  if (text === 'no-admin-key') {
    return '还没配置管理密钥（adminKey）。CPA 的账号列表与登录流程都要它，去 data/config.json 里填，或跑 npm run setup。'
  }
  if (text.includes('IP banned') === true) {
    const wait = /Try again in ([0-9hms ]+)/.exec(text)
    const left = wait === null ? '' : `还剩约 ${wait[1].trim()}。`
    return `CPA 把这个 IP 临时封了：连续输错的次数太多。${left}等它到期即可，别继续重试（每次失败都会重新计时）。数据面 /v1 通常不受影响。`
  }
  if (text.includes('invalid management key') === true) {
    return '管理密钥不对（CPA 回 invalid management key）。adminKey 要 management.secret-key 的明文，不是那个 bcrypt 哈希。'
  }
  return text
}

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
  if (!response.ok) {
    throw new Error(`CPA ${String(response.status)}: ${JSON.stringify(parsed).slice(0, 200)}`)
  }
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
    return { ok: false, error: explainUpstreamError(error?.message ?? error) }
  }
}

/** 登录会话缓存：`state` → `{ url, startedAt }`，只为界面回显。 */
const loginSessions = new Map()

/**
 * 上游版本操作的互斥位：`null` = 空闲，否则是正在处理的来源名。
 *
 * 两个动作都要挡：查版本会打 GitHub（限流 60 次/小时），更新会改磁盘。
 * 同一个进程内并发跑这两件事没有意义，只会让「装的是哪版」这条记录打架。
 */
const updates = { inFlight: null }

let poolCache = { at: 0, value: undefined }

/**
 * 读 workbuddy 的账号 + 余额，给管理页显示「池子里还有多少」。缓存 30 秒。
 *
 * ⚠️ 必须检查 `response.ok`。CPA 失败时回的是 `{error: "..."}`，
 *   不检查就会把封禁 / 密钥错误当成「账号列表为空」：
 *   `accountsBody?.accounts ?? []` 得到 `[]`，页面显示 `ok:true, accountCount:0`，
 *   用户看到的是「池子空了」而不是「读不到」—— 这两种状态必须分开。
 */
async function readPool() {
  const now = Date.now()
  if (poolCache.value !== undefined && now - poolCache.at < 30000) return poolCache.value
  if (ADMIN_KEY === '') return { ok: false, error: explainUpstreamError('no-admin-key') }
  try {
    const headers = { authorization: `Bearer ${ADMIN_KEY}` }
    const [accountsRes, creditsRes] = await Promise.all([
      fetch(`${CONFIG.upstream}/v0/management/plugins/${CONFIG.channel}/accounts`, { headers }),
      fetch(`${CONFIG.upstream}/v0/management/plugins/${CONFIG.channel}/credits`, { headers }),
    ])
    const accountsText = await accountsRes.text()
    const creditsText = await creditsRes.text()
    if (!accountsRes.ok) {
      throw new Error(`CPA ${String(accountsRes.status)}: ${accountsText.slice(0, 200)}`)
    }
    const accountsBody = parseJsonText(accountsText, {})
    const creditsBody = parseJsonText(creditsText, {})
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
        model: MODEL_STATE.upstream,
        accountCount: accountsBody?.accounts?.length ?? rows.length,
        remain,
        used,
        size,
        accounts: rows,
      },
    }
    return poolCache.value
  } catch (error) {
    return { ok: false, error: explainUpstreamError(error?.message ?? error) }
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

/* ──────────────────────────── 连通性自检 ──────────────────────────── */

/**
 * 「现在到底能不能用」—— 页面上要能一眼看见，而不是等客户端报错才发现。
 *
 * 四个探针，各管一件事：
 *   1. data  —— 拿 upstreamKey 打 `/v1/models`：这条就是客户端真正走的那条路；
 *   2. admin —— 拿 adminKey 打 `auth-files`：账号列表与登录都靠它；
 *   3. tunnel—— 从 cloudflared 的日志里读出公网地址与 metrics 端口，
 *               再探 metrics 判断隧道进程是不是还活着（本地、快）；
 *   4. keys  —— 每把 key 最近一次调用成功与否（从账本读，不发请求）。
 *
 * 刻意**不**自动去 fetch 公网地址：那是绕一圈公网回来，慢且会消耗一次自检请求。
 * 要验「公网真的通」就点页面上的按钮，走 `POST /admin/api/health/tunnel`。
 */

/** 隧道日志里 `cloudflared` 会打印 `https://<随机词>.trycloudflare.com`。 */
const TUNNEL_LOG = path.join(DATA_DIR, 'tunnel.log')
const TUNNEL_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/gi
const TUNNEL_METRICS_RE = /Starting metrics server on (127\.0\.0\.1:\d+)/gi
const TUNNEL_CONNECTOR_RE = /Generated Connector ID:\s*([0-9a-fA-F-]{36})/g

function readTunnelFacts() {
  let text = ''
  let updatedAt = null
  try {
    const stat = fs.statSync(TUNNEL_LOG)
    /**
     * 只读前 128 KB：公网地址、metrics 端口、connector id 都在进程刚起来的那几十行里。
     * 隧道跑久了日志会很大，整份读进来纯属浪费（而且它在 data/ 里，可能上过百 MB）。
     */
    const length = Math.min(stat.size, 128 * 1024)
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(TUNNEL_LOG, 'r')
    try {
      fs.readSync(fd, buffer, 0, length, 0)
    } finally {
      fs.closeSync(fd)
    }
    text = buffer.toString('utf8')
    updatedAt = stat.mtime.toISOString()
  } catch {
    return {
      logFile: TUNNEL_LOG,
      logExists: false,
      url: null,
      metricsTarget: null,
      connectorId: null,
      updatedAt: null,
    }
  }

  const urls = [...text.matchAll(TUNNEL_URL_RE)].map((match) => match[0])
  const metrics = [...text.matchAll(TUNNEL_METRICS_RE)].map((match) => match[1])
  const connectors = [...text.matchAll(TUNNEL_CONNECTOR_RE)].map((match) => match[1])
  return {
    logFile: TUNNEL_LOG,
    logExists: true,
    /** 重启会换域名，取最后一次出现的那个。 */
    url: urls.length === 0 ? null : urls[urls.length - 1],
    /** 端口也可能换，同样取最后一个。 */
    metricsTarget: metrics.length === 0 ? null : metrics[metrics.length - 1],
    /**
     * 这条隧道进程的**身份**。
     *
     * ⚠️ 光探 metrics 端口通不通是不够的：那个端口（默认 20241）是全局的，
     *   机器上任何一条 cloudflared 都能占着它。只按「端口有响应」下结论，
     *   会把「别人的隧道」认成「日志里这条隧道还活着」，
     *   然后在页面上显示一个早已失效的公网地址（踩过：测试隧道一跑，
     *   生产页面就误报「运行中」，配的还是旧域名）。
     *   所以必须拿 connectorId 与 metrics 回来的值比对。
     */
    connectorId: connectors.length === 0 ? null : connectors[connectors.length - 1],
    updatedAt,
  }
}

/** 探 cloudflared 的 metrics 端口，并核对 connector id 是不是日志里那条。 */
async function probeTunnelProcess(metricsTarget, expectedConnectorId) {
  if (metricsTarget === null) return { alive: false, reason: 'no-metrics-target' }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    const response = await fetch(`http://${metricsTarget}/ready`, { signal: controller.signal })
    clearTimeout(timer)
    const text = await response.text().catch(() => '')
    if (response.ok !== true) {
      return { alive: false, status: response.status, reason: 'metrics-not-ready' }
    }
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    const seenConnector = typeof parsed?.connectorId === 'string' ? parsed.connectorId : null
    if (expectedConnectorId !== null && seenConnector !== expectedConnectorId) {
      return {
        alive: false,
        reason: 'connector-mismatch',
        seenConnector,
        expectedConnector: expectedConnectorId,
      }
    }
    return {
      alive: true,
      status: response.status,
      readyConnections: typeof parsed?.readyConnections === 'number' ? parsed.readyConnections : null,
      connectorId: seenConnector,
    }
  } catch (error) {
    return { alive: false, reason: String(error?.message ?? error).slice(0, 120) }
  }
}

/** 拿数据面探一次 `/v1/models` —— 与客户端调模型走同一条路。 */
async function probeDataPlane() {
  if (UPSTREAM_KEY === '') return { ok: false, reached: false, reason: 'no-upstream-key' }
  const startedAt = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const response = await fetch(`${CONFIG.upstream}/v1/models`, {
      headers: { authorization: `Bearer ${UPSTREAM_KEY}` },
      signal: controller.signal,
    })
    clearTimeout(timer)
    const text = await response.text().catch(() => '')
    return {
      ok: response.ok === true,
      reached: true,
      status: response.status,
      ms: Date.now() - startedAt,
      body: text.slice(0, 160),
    }
  } catch (error) {
    return { ok: false, reached: false, ms: Date.now() - startedAt, reason: String(error?.message ?? error) }
  }
}

/** 每把 key 最近一次调用：成功 / 失败 / 还没用过。 */
function lastCallByKey() {
  const latest = new Map()
  for (const row of readUsage()) {
    if (typeof row?.keyId !== 'string') continue
    const previous = latest.get(row.keyId)
    if (previous === undefined || String(row.ts ?? '') > String(previous.ts ?? '')) {
      latest.set(row.keyId, row)
    }
  }
  const out = new Map()
  for (const [keyId, row] of latest) {
    const status = Number(row.status ?? 0)
    out.set(keyId, {
      at: row.ts ?? null,
      status: Number.isFinite(status) ? status : null,
      ok: Number.isFinite(status) ? status >= 200 && status < 300 : false,
      account: row.account ?? null,
      error: typeof row.error === 'string' ? row.error : null,
      ms: typeof row.ms === 'number' ? row.ms : null,
    })
  }
  return out
}

async function readHealth() {
  const tunnel = readTunnelFacts()
  const [data, tunnelProcess] = await Promise.all([
    probeDataPlane(),
    probeTunnelProcess(tunnel.metricsTarget, tunnel.connectorId),
  ])
  const admin = ADMIN_KEY === ''
    ? { ok: false, reached: false, reason: 'no-admin-key' }
    : await (async () => {
        const startedAt = Date.now()
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 5000)
          const response = await fetch(`${CONFIG.upstream}/v0/management/auth-files`, {
            headers: { authorization: `Bearer ${ADMIN_KEY}` },
            signal: controller.signal,
          })
          clearTimeout(timer)
          const text = await response.text().catch(() => '')
          return {
            ok: response.ok === true,
            reached: true,
            status: response.status,
            ms: Date.now() - startedAt,
            hint: response.ok === true ? null : explainUpstreamError(`CPA ${String(response.status)}: ${text.slice(0, 200)}`),
          }
        } catch (error) {
          return { ok: false, reached: false, ms: Date.now() - startedAt, reason: String(error?.message ?? error) }
        }
      })()

  const lastCalls = lastCallByKey()
  return {
    ok: data.ok === true,
    checkedAt: new Date().toISOString(),
    upstream: { url: CONFIG.upstream, keyFrom: UPSTREAM.source, data, admin },
    tunnel: {
      running: tunnelProcess.alive === true,
      publicUrl: tunnel.url,
      metricsTarget: tunnel.metricsTarget,
      connectorId: tunnel.connectorId,
      logFile: tunnel.logFile,
      logExists: tunnel.logExists,
      updatedAt: tunnel.updatedAt,
      process: tunnelProcess,
      /** 公网可达性是「点了才测」，默认 null = 没测过。 */
      publicOk: null,
    },
    keys: store.keys.map((item) => ({
      id: item.id,
      name: item.name,
      enabled: item.enabled !== false,
      lastCall: lastCalls.get(item.id) ?? null,
    })),
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

  // 模型目录：报当前真实可用的那些别名，客户端就不会去试别的。
  if (url.pathname === '/v1/models' && request.method === 'GET') {
    return jsonRes(response, {
      object: 'list',
      data: MODEL_STATE.accept.map((id) => ({
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
  if (!MODEL_STATE.accept.includes(asked)) {
    // 这一层只放行 workbuddy 的 deepseek-v4.1，别的模型明确拒绝 —— 不静默改写。
    return openaiError(
      response,
      404,
      `本 key 只提供 ${MODEL_STATE.upstream}（${CONFIG.channel} 渠道）。${asked} 不在可用列表里。`,
      'model_not_found',
      'model',
    )
  }

  // 一律改写成上游认的那个 id：`deepseek-v4.1` 这类短名也走同一条路。
  const upstreamBody = JSON.stringify({ ...payload, model: MODEL_STATE.upstream })
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
        model: MODEL_STATE.upstream,
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
        model: MODEL_STATE.upstream,
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

/**
 * 管理接口的鉴权。
 *
 * 返回 `null` = 通过；返回字符串 = 该拒绝的理由（直接放进响应）。
 *
 * 口令从哪来：`data/config.json` 的 `adminPassword`，或环境变量 `BUDDYKEY_ADMIN_PASSWORD`。
 * 页面把它存在 `sessionStorage`（关标签就没），每次带 `authorization: Bearer <口令>`。
 *
 * 为什么用 Bearer 而不是 Cookie：不用签名、不用管 SameSite、不用处理 CSRF ——
 * 这个页面对同一个源发请求，加一个头就够；而 Cookie 方案要额外防跨站伪造。
 */
const ADMIN_PASSWORD = (() => {
  const fromEnv = typeof process.env.BUDDYKEY_ADMIN_PASSWORD === 'string' ? process.env.BUDDYKEY_ADMIN_PASSWORD : ''
  return fromEnv !== '' ? fromEnv : String(CONFIG.adminPassword ?? '')
})()

function sameSecret(given, expected) {
  const a = Buffer.from(String(given), 'utf8')
  const b = Buffer.from(String(expected), 'utf8')
  /** 长度不同直接失败；`timingSafeEqual` 要求等长，否则抛。 */
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function adminAuthFailure(request) {
  /** 没设口令 = 不设防（启动时已保证这只会发生在只绑本机的情况）。 */
  if (ADMIN_PASSWORD === '') return null

  const raw = request.headers.authorization
  const header = typeof raw === 'string' ? raw.trim() : ''
  const bearer = /^Bearer\s+(.+)$/i.exec(header)
  const token = bearer !== null ? bearer[1].trim() : typeof request.headers['x-admin-token'] === 'string'
    ? String(request.headers['x-admin-token']).trim()
    : ''

  if (token === '') return '管理接口需要口令：在页面顶部填入 adminPassword（或环境变量 BUDDYKEY_ADMIN_PASSWORD）。'
  if (sameSecret(token, ADMIN_PASSWORD) !== true) return '管理口令不对。'
  return null
}

async function adminApi(request, response, url) {
  const pathname = url.pathname

  /**
   * 管理接口的第一道门。
   *
   * `adminPassword` 空着时直接放行 —— 但启动时已经拦过「非回环 + 空口令」，
   * 所以能走到这里的空口令实例一定只绑在本机，别人碰不到。
   *
   * 口令比较走 `timingSafeEqual`：`===` 会在第一个不同字节处返回，
   * 逐字节的耗时差理论上能被用来猜口令。长度不同先挡掉（`timingSafeEqual` 要求等长）。
   */
  if (adminAuthFailure(request) !== null) {
    const failure = adminAuthFailure(request)
    response.writeHead(401, {
      'content-type': 'application/json; charset=utf-8',
      /** 不带 realm 的话浏览器不会弹原生口令框，页面自己处理。 */
      'www-authenticate': 'Bearer realm="BuddyKey"',
    })
    response.end(JSON.stringify({ ok: false, error: failure, code: 'admin_auth_required' }))
    return
  }

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
      return jsonRes(response, { ok: false, error: explainUpstreamError(error?.message ?? error) }, 502)
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
      return jsonRes(response, { ok: false, error: explainUpstreamError(error?.message ?? error) }, 502)
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
      return jsonRes(response, { ok: false, error: explainUpstreamError(error?.message ?? error) }, 502)
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
      return jsonRes(response, { ok: false, error: explainUpstreamError(error?.message ?? error) }, 502)
    }
  }

  if (pathname === '/admin/api/state' && request.method === 'GET') {
    const usage = readUsage()
    const summary = usageSummary(usage)
    const byKey = new Map(summary.map((row) => [row.keyId, row]))
    const lastCalls = lastCallByKey()
    const pool = await readPool()
    const nicknames =
      pool.ok === true ? new Map(pool.accounts.map((a) => [a.authIndex, a.nickname])) : new Map()
    const nicknameOf = (authIndex) => nicknames.get(authIndex) ?? authIndex
    return jsonRes(response, {
      ok: true,
      models: MODEL_STATE.accept.length > 0 ? MODEL_STATE.accept : [MODEL_STATE.upstream],
      modelSource: MODEL_STATE.source,
      channel: CONFIG.channel,
      /**
       * 首次上手要用：页面在「一个号都没有」时据此给出具体缺什么、去哪配，
       * 而不是只画一句「读不到账号」让用户去翻 README。
       */
      setup: {
        upstream: CONFIG.upstream,
        upstreamKey: UPSTREAM_KEY === '' ? 'missing' : 'ok',
        adminKey: ADMIN_KEY === '' ? 'missing' : 'ok',
        upstreamKeyFrom: UPSTREAM.source,
        adminKeyFrom: ADMIN.source,
        configFile: CONFIG_FILE,
        envNames: [CONFIG.upstreamKeyEnv, CONFIG.adminKeyEnv],
        refsFile: path.join(os.homedir(), '.dsh', '.credentials.yaml'),
        boundModel: MODEL_STATE.upstream,
        boundModelSource: MODEL_STATE.source,
      },
      pool,
      keys: store.keys.map((item) => {
        const stat = byKey.get(item.id)
        const scope = scopeOf(item)
        const lastCall = lastCalls.get(item.id) ?? null
        /**
         * 「现在还能不能调」与「上次调用成不成」是两件事。
         *
         * ⚠️ 429 不写账本（设计如此：不消耗上游），所以被限流的 key 的 `lastCall`
         *   会**一直停在成功那次**。只看 `lastCall` 会得出「一切正常」的错误结论。
         *   这里把本地的额度判断也算出来，让页面能直接说「当前被限额拦住」。
         */
        const refusal = quotaRefusal(item)
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
          /** 这把 key「现在能不能用」的直接证据：最近一次调用成不成。 */
          lastCall,
          /** 现在这一刻是否会被额度闸门拦下（`null` = 不会被拦）。 */
          blocked: refusal === null ? null : { message: refusal.message, limit: refusal.limit },
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

  if (pathname === '/admin/api/health' && request.method === 'GET') {
    return jsonRes(response, await readHealth())
  }

  /* ── 上游版本 ── */

  /**
   * 查上游有没有新版。
   *
   * ⚠️ 与 `/admin/api/state` 分开是有意的：这条路要打一次 GitHub API，
   *   而未认证限流是 60 次/小时。`state` 会被页面反复轮询，合在一起等于
   *   每次轮询都去问一次上游 —— 既不礼貌，也会让页面偶尔无故报错。
   *   （与 dsh-cpa-switch 把 `/plugins-update` 从 `/setup` 里拆出来同一个理由。）
   *
   * `?key=` 空着取默认来源（渠道插件）；CPA 本体在页面上不暴露，但机制通用。
   */
  if (pathname === '/admin/api/updates' && request.method === 'GET') {
    const key = resolveSourceKey(url.searchParams.get('key') ?? '')
    if (key === undefined) {
      return jsonRes(response, { ok: false, reason: 'unknown-source', error: `不认识的来源：${String(url.searchParams.get('key'))}` }, 400)
    }
    if (updates.inFlight !== null) return jsonRes(response, { ok: false, reason: 'busy', error: '上一次检查还没结束' }, 429)
    updates.inFlight = key
    try {
      return jsonRes(response, await checkUpdate(key))
    } finally {
      updates.inFlight = null
    }
  }

  /**
   * 更新：**用户点了才换**，从不自动跑。
   *
   * 顺序是「先确认 CPA 停着 → 再换文件」。Windows 上被加载的 dll 改不了名，
   * 所以这里必须先看上游通不通：
   *   - 通着 → 拒绝，说清楚要先停 CPA（BuddyKey 不是 CPA 的父进程，停不掉它，
   *     也不去做越权的事：杀一个自己没启动的进程和杀自己的是两件事）；
   *   - 不通 → 直接换（多半用户已经 Ctrl+C 停了 `npm run cpa`）。
   *
   * ⚠️ 换完**不自动起 CPA**，也不自动重连：替用户决定「重启」与
   *   「不越权」的口径相反。`stopped` 如实回给界面。
   */
  if (pathname === '/admin/api/updates' && request.method === 'POST') {
    const body = parseJsonText(await safeJson(request), {})
    const key = resolveSourceKey(typeof body.key === 'string' ? body.key : '')
    if (key === undefined) {
      return jsonRes(response, { ok: false, reason: 'unknown-source', error: '不认识的来源' }, 400)
    }
    if (updates.inFlight !== null) {
      return jsonRes(response, { ok: false, reason: 'busy', error: '上一次操作还没结束' }, 429)
    }

    updates.inFlight = key
    try {
      /**
       * ⚠️ 判据是 `reached` 不是 `ok`：CPA 回了 401 也说明**进程活着、dll 已加载**，
       *   文件照样改不了名。只看 `ok` 会在密钥不对时误判成「CPA 没跑」，
       *   然后去换一个正被占用的 dll，拿一个看不懂的 EBUSY。
       */
      const reachable = await probeDataPlane()
      if (reachable.reached === true) {
        return jsonRes(
          response,
          {
            ok: false,
            reason: 'upstream-running',
            error:
              'CPA 还在运行，插件文件被占用、改不了名。先停掉它' +
              '（跑 npm run cpa 的那个窗口按 Ctrl+C），再来更新。',
          },
          409,
        )
      }

      const outcome = await installSource(key, { force: true })
      if (outcome.ok !== true) {
        return jsonRes(
          response,
          { ok: false, reason: outcome.phase ?? 'install-failed', error: outcome.error ?? '未知原因' },
          502,
        )
      }

      /**
       * ⚠️ 换完必须重新探模型目录：插件换版本时模型前缀会变
       *   （`wb/` ↔ `cn/`，已实测）。不重探就会「插件更新成功、
       *   但之后每个请求都 400 unknown provider」，而且报错指向 model，
       *   完全看不出跟刚才那个更新有关。
       */
      await probeModelCatalog()

      return jsonRes(response, {
        ok: true,
        key,
        tag: outcome.tag,
        name: outcome.name,
        /** sha256 真校验过没有（上游没给 digest 时是 false）。 */
        verified: outcome.verified,
        /** CPA 现在多半是停着的，界面据此提示用户去手动启动。 */
        stopped: reachable.reached !== true,
        model: MODEL_STATE.upstream,
        modelSource: MODEL_STATE.source,
        models: MODEL_STATE.accept,
      })
    } finally {
      updates.inFlight = null
    }
  }

  /**
   * 「公网真的通吗」—— 只有点了才走这条路。
   *
   * 从本机去 fetch 自己的 trycloudflare 地址，流量要绕出去再从隧道回来，
   * 一次几百毫秒到几秒。所以不放进自动轮询，做成显式动作。
   */
  if (pathname === '/admin/api/health/tunnel' && request.method === 'POST') {
    const tunnel = readTunnelFacts()
    if (tunnel.url === null) {
      return jsonRes(
        response,
        { ok: false, reason: 'no-public-url', hint: '云隧道日志里还没有公网地址，先跑 start-tunnel.cmd。' },
        409,
      )
    }
    const startedAt = Date.now()
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      const probe = await fetch(`${tunnel.url}/healthz`, { signal: controller.signal })
      clearTimeout(timer)
      const text = await probe.text().catch(() => '')
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
      return jsonRes(response, {
        ok: probe.ok === true,
        publicUrl: tunnel.url,
        status: probe.status,
        ms: Date.now() - startedAt,
        health: parsed,
        checkedAt: new Date().toISOString(),
      })
    } catch (error) {
      return jsonRes(
        response,
        {
          ok: false,
          publicUrl: tunnel.url,
          ms: Date.now() - startedAt,
          reason: String(error?.message ?? error),
          hint: '隧道进程可能已经退出。重新跑 start-tunnel.cmd 再来。',
        },
        502,
      )
    }
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

/** 管理页是纯静态资源，放在 `lib/ui.mjs`（顶部 import），这里只负责两个占位符。 */

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
      const models = MODEL_STATE.accept.length > 0 ? MODEL_STATE.accept.join(' / ') : MODEL_STATE.upstream
      return send(
        response,
        200,
        { 'content-type': 'text/html; charset=utf-8' },
        PAGE.replace('__LAN_HINT__', hint)
          .replace('__MODELS__', models)
          .replace('__UPDATE_TEXT__', UPDATE_TEXT_BROWSER),
      )
    }
    if (url.pathname === '/healthz') {
      /**
       * 把两个密钥的**来源**也报出来。
       * 「配了没生效」和「压根没配」的排查路径完全不同，靠 `missing` 一个词分不开。
       */
      return jsonRes(response, {
        ok: true,
        model: MODEL_STATE.upstream,
        modelSource: MODEL_STATE.source,
        models: MODEL_STATE.accept,
        channel: CONFIG.channel,
        upstream: CONFIG.upstream,
        upstreamKey: UPSTREAM_KEY === '' ? 'missing' : 'ok',
        adminKey: ADMIN_KEY === '' ? 'missing' : 'ok',
        upstreamKeyFrom: UPSTREAM.source,
        adminKeyFrom: ADMIN.source,
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

const SOURCE_LABEL = { config: 'config.json', env: '环境变量', refs: '.credentials.yaml', none: '未配置' }

/**
 * 先探一次模型目录再开始监听。
 *
 * ⚠️ 必须 await：`/v1/models` 与 `acceptModels` 校验都依赖探测结果。
 *   不 await 就会出现「服务已起、前几个请求按兜底模型名打、全 400」的竞态，
 *   而且过一会儿又自己好了 —— 最难查的那种。
 */
await probeModelCatalog()

/**
 * 安全闸门：非回环地址 + 空管理口令 = 拒绝启动。
 *
 * 为什么是「拒绝」而不是「警告后照常起」：警告在终端里滚过去就没了，
 * 而 `/admin/api/*` 无口令意味着**任何能连上这个端口的人都能给自己发一把 key**
 * （实测过：无凭据 POST 直接 200 返回可用 key）。这种口子不该靠人自觉。
 *
 * 只绑本机时不拦 —— 127.0.0.1 别人碰不到，这是本项目的默认用法。
 */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '']
if (LOOPBACK_HOSTS.includes(CONFIG.host) !== true && ADMIN_PASSWORD === '') {
  console.error('')
  console.error(`拒绝启动：监听地址是 ${CONFIG.host}（不是本机），但没设管理口令。`)
  console.error('')
  console.error('这样起的话，任何能连上这个端口的人都能打开管理接口、给自己发一把可用的 key，')
  console.error('直接消耗你的额度。所以必须先设一个口令，二选一：')
  console.error('')
  console.error(`  A) 在 ${CONFIG_FILE} 里加一行： "adminPassword": "<你自己定的口令>"`)
  console.error('  B) 启动时设环境变量：BUDDYKEY_ADMIN_PASSWORD=<你自己定的口令>')
  console.error('')
  console.error('只想本机用（不对外暴露）就把 host 改回 "127.0.0.1"。')
  console.error('')
  process.exit(1)
}

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`BuddyKey listening on http://${CONFIG.host}:${CONFIG.port}`)
  console.log(`  管理页   http://${CONFIG.host}:${CONFIG.port}/`)
  if (ADMIN_PASSWORD === '') {
    console.log('  管理鉴权 未设口令（只绑本机，安全）')
  } else {
    console.log(`  管理鉴权 已设口令（${String(ADMIN_PASSWORD.length)} 字符）`)
  }
  console.log(`  允许模型 ${MODEL_STATE.upstream}（渠道 ${CONFIG.channel}，来源 ${MODEL_STATE.source}）`)
  if (MODEL_STATE.source === 'fallback' && MODEL_STATE.candidates.length === 0) {
    console.log('           ⚠️ 没能从 CPA 探测到模型目录（上游没起？）。现在用的是兜底名，')
    console.log('              上游一旦起来、名字对不上就会 400 unknown provider —— 到时重启一次即可。')
  }
  if (MODEL_STATE.source === 'probe' && CONFIG.modelFallback[0] !== MODEL_STATE.upstream) {
    console.log(`           （插件换了前缀：兜底猜的 ${CONFIG.modelFallback[0]} 不存在，实际用探测到的。）`)
  }
  console.log(
    `  上游     ${CONFIG.upstream}   key=${UPSTREAM_KEY === '' ? '缺失' : '已取到'}（来源 ${SOURCE_LABEL[UPSTREAM.source]}）`,
  )
  console.log(
    `  管理 key ${ADMIN_KEY === '' ? '缺失（池子余额与账号列表都不显示）' : '已取到'}（来源 ${SOURCE_LABEL[ADMIN.source]}）`,
  )
  console.log(`  数据目录 ${DATA_DIR}`)
  if (UPSTREAM_KEY === '' || ADMIN_KEY === '') {
    console.log('')
    console.log('  ⚠️ 还差 CPA 密钥，这个进程现在只能用来看页面。二选一：')
    console.log(`     A) 编辑 ${CONFIG_FILE}，写 "upstreamKey" 与 "adminKey"`)
    console.log(`     B) 设环境变量 ${CONFIG.upstreamKeyEnv} / ${CONFIG.adminKeyEnv}`)
    console.log('     取值位置：CPA 的 config.yaml 里 access.api-keys 与 management.secret-key（明文形态）。')
    console.log('     也可以先跑 `npm run setup` 交互式填一遍。')
  }
})

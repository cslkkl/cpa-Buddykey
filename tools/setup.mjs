#!/usr/bin/env node
/**
 * `npm run setup` —— 把「别人拉下来要配什么」变成一问一答。
 *
 * 两种模式：
 *   - 交互：`npm run setup`，一条条问，回车用方括号里的默认值；
 *   - 非交互：带参数跑，适合脚本 / CI / 远程指导别人粘贴一段命令。
 *
 *     node tools/setup.mjs --upstream-key sk-… --admin-key … --yes
 *
 * 只写 `data/config.json`（已存在先备份），不碰 keys.json / usage.jsonl。
 * 密钥会明文落进这个文件，而 `data/` 已在 `.gitignore` 里。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const DATA_DIR = path.join(ROOT, 'data')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const SAMPLE_FILE = path.join(ROOT, 'config.sample.json')

/** CPA 在 Windows 上的常见落点，按「最可能是这台机器的」排前面。 */
const CPA_CONFIG_CANDIDATES = [
  path.join(os.homedir(), '.dsh', 'cpa-panel', 'runtime', 'cpa', 'config.yaml'),
  path.join(os.homedir(), '.cli-proxy-api', 'config.yaml'),
  path.join(os.homedir(), '.cli-proxy-api', 'config.yml'),
]

const say = (text = '') => process.stdout.write(`${text}\n`)

/* ────────────────────────────── 参数 ────────────────────────────── */

function parseArgs(argv) {
  const out = { flags: {}, rest: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      out.rest.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq > 2) {
      out.flags[token.slice(2, eq)] = token.slice(eq + 1)
      continue
    }
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out.flags[name] = next
      i += 1
    } else {
      out.flags[name] = 'true'
    }
  }
  return out
}

const ARGS = parseArgs(process.argv.slice(2))
const flag = (name) => (typeof ARGS.flags[name] === 'string' ? ARGS.flags[name] : undefined)
const hasFlag = (name) => ARGS.flags[name] !== undefined

/* ──────────────────────────── 行读取 ──────────────────────────── */

/**
 * 自己管行队列，不用 `rl.question`。
 *
 * 为什么：`rl.question` 之间有 await（探测 CPA 要几个网络往返），
 * 管道喂答案时 stdin 早就读完、readline 已 close，第二个 question 直接 reject
 * （「readline was closed」）。改成「行进来就入队，要的时候就取」，
 * 交互与管道两种输入都稳。
 */
function createLineSource() {
  const queue = []
  const waiters = []
  let ended = false
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  })
  rl.on('line', (line) => {
    if (waiters.length > 0) waiters.shift()(line)
    else queue.push(line)
  })
  rl.on('close', () => {
    ended = true
    while (waiters.length > 0) waiters.shift()(null)
  })
  return {
    next(promptText) {
      process.stdout.write(promptText)
      if (queue.length > 0) return Promise.resolve(queue.shift())
      if (ended) return Promise.resolve(null)
      return new Promise((resolve) => waiters.push(resolve))
    },
    close() {
      rl.close()
    },
  }
}

async function ask(source, question, fallback) {
  const shown = fallback === undefined || fallback === '' ? '' : ` [${String(fallback)}]`
  const answer = await source.next(`  ${question}${shown}: `)
  if (answer === null) {
    // stdin 已结束（管道用完了 / Ctrl+Z）：安静地取默认值，不要炸。
    process.stdout.write('\n')
    return fallback ?? ''
  }
  const trimmed = String(answer).trim()
  return trimmed === '' ? (fallback ?? '') : trimmed
}

/* ──────────────────────────── CPA 探测 ──────────────────────────── */

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 从 CPA 的 config.yaml 里挖 `access.api-keys` 的第一条。
 *
 * 这是唯一能自动拿到的那个 —— 它在 config 里是明文。
 * `management.secret-key` 是 bcrypt（`$2a$…`）哈希，物理上还原不出明文，所以不去碰它。
 *
 * ⚠️ 别想着先圈出 `access:` 这一块再找 —— 带 `m` 标志时 `$` 只匹配行尾，
 *   `(?=^\S|$)` 会在 `access:` 那一行就满足，块内容恒为空（踩过一次）。
 *   直接按行找 `api-keys` 更稳。
 */
function sniffCpaApiKey(configText) {
  // 块状写法：api-keys: 换行后跟一串 "- xxx"
  const listBlock = /^[ \t]*api-keys:[ \t]*\r?\n((?:[ \t]*-[ \t]*.*\r?\n)+)/m.exec(configText)
  if (listBlock !== null) {
    const first = /-[ \t]*["']?([^"'\s#]+)["']?/.exec(listBlock[1])
    if (first !== null) return first[1]
  }
  // 行内写法：api-keys: ["xxx", "yyy"]
  const inline = /^[ \t]*api-keys:[ \t]*\[([^\]]*)\]/m.exec(configText)
  if (inline !== null) {
    const first = /["']?([^"'\s,\]]+)["']?/.exec(inline[1])
    if (first !== null) return first[1]
  }
  return ''
}

function findCpaConfig() {
  for (const file of CPA_CONFIG_CANDIDATES) {
    if (fs.existsSync(file)) return file
  }
  return ''
}

async function probeUpstream(base, adminKey) {
  const root = String(base).replace(/\/+$/, '')
  /**
   * ⚠️ 只在这一步真打一次，而且**没有密钥就不打**。
   *
   * CPA 对 /v0/management/* 有 IP 级失败计数：连错几次直接
   * `403 IP banned due to too many failed attempts, Try again in 30m`。
   * 用空 key 去「探活」也算一次失败，所以空 key 时改用不鉴权的轻量探测，
   * 免得用户还没开始配就被封半小时。
   */
  const hasKey = typeof adminKey === 'string' && adminKey.trim() !== ''
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const response = await fetch(`${root}${hasKey ? '/v0/management/auth-files' : '/v1/models'}`, {
      headers: hasKey ? { authorization: `Bearer ${adminKey}` } : {},
      signal: controller.signal,
    })
    clearTimeout(timer)
    const text = await response.text().catch(() => '')
    let accounts = null
    if (hasKey === true && response.ok === true) {
      try {
        const body = JSON.parse(text)
        const files = Array.isArray(body?.files) ? body.files : []
        accounts = files.filter((file) => file?.provider !== undefined).length
      } catch {
        accounts = null
      }
    }
    return {
      reachable: true,
      status: response.status,
      ok: response.ok === true,
      accounts,
      banned: bannedMessageOf(text),
    }
  } catch (error) {
    return { reachable: false, error: String(error?.message ?? error) }
  }
}

/** CPA 的封禁提示原样带回来 —— 里面的剩余时间对用户是必要信息。 */
function bannedMessageOf(text) {
  if (typeof text !== 'string' || text === '') return null
  if (text.includes('IP banned') !== true) return null
  try {
    const parsed = JSON.parse(text)
    const message = typeof parsed?.error === 'string' ? parsed.error : ''
    // "IP banned due to too many failed attempts. Try again in 29m41s"
    const wait = /Try again in ([0-9hms ]+)/.exec(message)
    return { message, waitFor: wait === null ? null : wait[1].trim() }
  } catch {
    return { message: 'IP banned', waitFor: null }
  }
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function main() {
  const existing = readJsonFile(CONFIG_FILE, {})
  const sample = readJsonFile(SAMPLE_FILE, {})

  const nonInteractive = ['upstream-key', 'admin-key', 'upstream', 'port', 'channel', 'model'].some(hasFlag) ||
    hasFlag('yes')

  if (nonInteractive !== true) {
    say('')
    say('BuddyKey 首次配置')
    say('──────────────────────────────────────────────')
    say('只写 data/config.json，不动 keys.json / usage.jsonl。回车用方括号里的默认值。')
    say('')
  }

  const source = nonInteractive === true ? null : createLineSource()
  const pick = async (question, flagName, fallback) => {
    const fromFlag = flag(flagName)
    if (fromFlag !== undefined) return fromFlag
    if (source === null) return fallback ?? ''
    return await ask(source, question, fallback)
  }

  try {
    if (source !== null) say('1) 上游 CPA 在哪')
    const upstream = await pick('CPA 地址', 'upstream', existing.upstream ?? sample.upstream ?? 'http://127.0.0.1:8317')

    if (source !== null) {
      const probe = await probeUpstream(upstream, '')
      if (probe.reachable === true) {
        say(`   ✓ 能连上（HTTP ${String(probe.status)}）`)
        if (probe.status === 401) say('     401 正常：这个接口要管理密钥，下一步就填。')
      } else {
        say(`   ⚠️ 连不上：${probe.error}`)
        say('     先把 CPA（cli-proxy-api）起起来，否则后面登录账号会失败。')
      }
      say('')

      say('2) 上游 API key（BuddyKey 拿它去调 CPA）')
    }
    const cpaConfig = findCpaConfig()
    let sniffed = ''
    if (cpaConfig !== '') {
      sniffed = sniffCpaApiKey(readText(cpaConfig))
      if (source !== null) {
        say(`   在 ${cpaConfig} 里找到了 access.api-keys`)
        if (sniffed !== '') say(`   自动填入：${sniffed.slice(0, 6)}…（长度 ${String(sniffed.length)}）`)
      }
    } else if (source !== null) {
      say('   没找到本机 CPA 的 config.yaml，只能手填。')
    }
    const upstreamKey = await pick('upstreamKey', 'upstream-key', existing.upstreamKey ?? sniffed)

    if (source !== null) {
      say('')
      say('3) 管理密钥（读写 CPA 的账号列表与登录流程）')
      say('   这是 CPA config.yaml 里 management.secret-key 的**明文**。')
      say('   那个字段可能是 bcrypt（$2a$…），哈希还原不出明文，要用你当初设的原值；')
      say('   忘了就去 CPA 面板重置一个。')
    }
    const adminKey = await pick('adminKey', 'admin-key', existing.adminKey ?? '')

    if (source !== null) {
      say('')
      say('4) 渠道与模型')
    }
    const channel = await pick('渠道名', 'channel', existing.channel ?? sample.channel ?? 'workbuddy')
    const model = await pick('锁定的模型', 'model', existing.model ?? sample.model ?? 'wb/deepseek-v4.1-flash')
    const portText = await pick('本服务监听端口', 'port', String(existing.port ?? sample.port ?? 8318))
    const port = Number(portText)
    if (source !== null) say('')

    const next = {
      ...sample,
      ...existing,
      upstream,
      upstreamKey,
      adminKey,
      channel,
      model,
      port: Number.isFinite(port) && port > 0 ? Math.floor(port) : 8318,
    }

    fs.mkdirSync(DATA_DIR, { recursive: true })
    if (fs.existsSync(CONFIG_FILE)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backup = `${CONFIG_FILE}.bak-${stamp}`
      fs.copyFileSync(CONFIG_FILE, backup)
      say(`   已备份旧配置：${path.relative(ROOT, backup)}`)
    }
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    say(`   已写入 ${path.relative(ROOT, CONFIG_FILE)}`)
    say('')

    // 写完立刻用真密钥验一次，省得用户起了服务才发现填错。
    // 只在管理密钥填了才验 —— 空 key 去打管理接口会白送一次失败计数。
    let verified = false
    if (adminKey !== '') {
      const check = await probeUpstream(upstream, adminKey)
      if (check.reachable !== true) {
        say(`⚠️ 上游连不上：${check.error}`)
      } else if (check.banned !== null) {
        say(`⚠️ CPA 已把这个 IP 临时封了：${check.banned.message}`)
        say('   通常是用错的管理密钥反复重试触发的。等它到期，或到 CPA 面板里解封。')
        say('   这期间数据面（/v1）通常还能用，只是读不到账号列表。')
      } else if (check.ok === true) {
        verified = true
        say(`✓ 管理密钥有效，CPA 里读到 ${String(check.accounts ?? 0)} 个凭据文件。`)
      } else {
        say(
          `⚠️ 上游回 HTTP ${String(check.status)} —— 管理密钥大概率不对` +
            '（adminKey 要 management.secret-key 的明文）。',
        )
      }
      say('')
    }

    const missing = []
    if (upstreamKey === '') missing.push('upstreamKey')
    if (adminKey === '') missing.push('adminKey')
    if (missing.length > 0) {
      say(`⚠️ 还差 ${missing.join(' / ')}，服务能起，但登录账号和调模型都会失败。`)
      say('   可以重跑 `npm run setup` 补上。')
      say('')
    }

    say('下一步')
    say('  1. npm start')
    say(`  2. 打开 http://127.0.0.1:${String(next.port)}/ ，点「登录 WorkBuddy 账号」扫码授权`)
    say('  3. 回页面点「创建 API key」，明文只显示一次，复制保存')
    say('  4. 用它请求：Base URL 是 /v1，模型填 deepseek-v4.1')
    say('')
    say('提示：config.json 里有密钥明文，data/ 已在 .gitignore 里 —— 别提交、别外发。')
    say('')
    process.exitCode = missing.length === 0 && (verified === true || adminKey === '') ? 0 : 2
  } finally {
    if (source !== null) source.close()
  }
}

main().catch((error) => {
  process.stderr.write(`setup 失败：${String(error?.message ?? error)}\n`)
  process.exitCode = 1
})

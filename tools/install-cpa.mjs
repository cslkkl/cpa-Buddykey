#!/usr/bin/env node
/**
 * `npm run install-cpa` —— 把上游那一层装进项目里。
 *
 * 这是**交互外壳**：问清「装到哪、用什么端口、两个密钥是什么」，
 * 真正的下载 / 校验 / 解压 / 替换全部委托给 `tools/upstream.mjs`。
 * 这样「首次安装」与「强制更新」走的是同一份代码 ——
 * 强制更新若在外面重写一遍流水线，第一件被漏掉的通常就是 sha256 校验
 * （参考实现在决策记录里把这条写死了）。
 *
 * 三条原则：
 *   1. **不碰别人的 CPA**：探测到本机已有就默认复用，只拷贝它那两个密钥；
 *      要装本项目专用的一套得显式 `--download`。
 *   2. **只下官方来源，且校验 sha256**：校验不过就当没下过。
 *   3. **幂等**：已有且校验通过就跳过（`force` 才重下）。
 *
 * 目录约定：全部落在 `<项目>/runtime/cpa/`（已 gitignore）。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  CPA_DIR,
  PLUGIN_DIR,
  PLAT,
  installSource,
  readInstalled,
  readState,
  sourcePresent,
  writeState,
} from './upstream.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CPA_CONFIG = path.join(CPA_DIR, 'config.yaml')

/** 别人机器上可能已经装好的 CPA 落点（只读探测，不写）。 */
const EXISTING_CPA_CANDIDATES = [
  path.join(os.homedir(), '.dsh', 'cpa-panel', 'runtime', 'cpa'),
  path.join(os.homedir(), '.cli-proxy-api'),
]

const say = (text = '') => process.stdout.write(`${text}\n`)
const warn = (text) => process.stdout.write(`⚠️  ${text}\n`)
const step = (n, text) => process.stdout.write(`\n[${String(n)}] ${text}\n`)

/* ────────────────────────────── 参数 ────────────────────────────── */

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--') !== true) continue
    const eq = token.indexOf('=')
    if (eq > 2) {
      flags[token.slice(2, eq)] = token.slice(eq + 1)
      continue
    }
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && next.startsWith('--') !== true) {
      flags[name] = next
      i += 1
    } else {
      flags[name] = 'true'
    }
  }
  return flags
}

const FLAGS = parseArgs(process.argv.slice(2))
const flag = (name) => (typeof FLAGS[name] === 'string' ? FLAGS[name] : undefined)
const hasFlag = (name) => FLAGS[name] !== undefined

/* ──────────────────────────── 行读取 ──────────────────────────── */

/**
 * 自管行队列，不用 `rl.question`。
 * 理由：探测与下载之间要 await，管道喂答案时 stdin 早就读完、readline 已 close，
 * 第二个 question 直接 reject（`readline was closed`）。
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
    process.stdout.write('\n')
    return fallback ?? ''
  }
  const trimmed = String(answer).trim()
  return trimmed === '' ? (fallback ?? '') : trimmed
}

/* ──────────────────────────── 基础工具 ──────────────────────────── */

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeFileAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${String(process.pid)}`
  fs.writeFileSync(tmp, data)
  if (mode !== undefined) fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, file)
}

/**
 * 端口上有没有东西在服务。
 *
 * ⚠️ 不能靠 `error.message`：Node 的 fetch 在连接被拒时抛 `TypeError: fetch failed`，
 *   `ECONNREFUSED` 藏在 `error.cause.code` 里。只看 message 会把「没人在听」
 *   误判成「已占用」（踩过）。
 */
async function portInUse(port) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/models`, { signal: controller.signal })
    clearTimeout(timer)
    return { listening: true, status: response.status }
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? ''
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return { listening: false, code }
    if (error?.name === 'AbortError') return { listening: true, code: 'timeout' }
    return { listening: true, code: code === '' ? 'unknown' : code }
  }
}

function detectExistingCpa() {
  const found = []
  for (const dir of EXISTING_CPA_CANDIDATES) {
    const exe = path.join(dir, `cli-proxy-api${PLAT.exe}`)
    if (fs.existsSync(exe)) {
      let plugins = []
      try {
        plugins = fs
          .readdirSync(path.join(dir, 'plugins'))
          .filter((name) => new RegExp(`\\${PLAT.lib}$`, 'i').test(name))
      } catch {
        plugins = []
      }
      found.push({
        dir,
        exe,
        hasConfig: fs.existsSync(path.join(dir, 'config.yaml')),
        plugins,
      })
    }
  }
  return found
}

/** 从一份 CPA config.yaml 里读出 api-key 与 secret-key 的**明文**（能读就读）。 */
function readCpaKeys(configFile) {
  let text = ''
  try {
    text = fs.readFileSync(configFile, 'utf8')
  } catch {
    return { apiKey: '', secretKey: '', secretIsHashed: false }
  }
  const apiMatch = /^[ \t]*api-keys:[ \t]*\r?\n((?:[ \t]*-[ \t]*.*\r?\n)+)/m.exec(text)
  let apiKey = ''
  if (apiMatch !== null) {
    const first = /-[ \t]*["']?([^"'\s#]+)["']?/.exec(apiMatch[1])
    if (first !== null) apiKey = first[1]
  } else {
    const inline = /^[ \t]*api-keys:[ \t]*\[([^\]]*)\]/m.exec(text)
    if (inline !== null) {
      const first = /["']?([^"'\s,\]]+)["']?/.exec(inline[1])
      if (first !== null) apiKey = first[1]
    }
  }
  const secretMatch = /^[ \t]*secret-key:[ \t]*["']?([^"'\r\n#]*)["']?/m.exec(text)
  const rawSecret = secretMatch === null ? '' : secretMatch[1].trim()
  const secretIsHashed = rawSecret.startsWith('$2') === true
  return { apiKey, secretKey: secretIsHashed ? '' : rawSecret, secretIsHashed }
}

/* ─────────────────────────── 生成 CPA 配置 ─────────────────────────── */

/**
 * 生成一份「只开 workbuddy 一个渠道」的最小 config。
 *
 * 刻意不抄 config.example.yaml：那份 85 KB、涵盖所有渠道与实验开关，
 * 抄过来等于把一堆与本项目无关的东西塞给用户。
 */
function buildCpaConfig({ port, apiKey, secretKey, usePluginsDir, oauthRegion }) {
  return [
    '# 由 BuddyKey 的 npm run install-cpa 生成。改之前先看 docs/ARCHITECTURE.md。',
    'config-version: 8',
    '',
    'server:',
    '  host: "127.0.0.1"',
    `  port: ${String(port)}`,
    '',
    'management:',
    '  allow-remote: false',
    '  # 明文写在这里，CPA 启动时会自己哈希；BuddyKey 需要这个明文去调管理接口。',
    `  secret-key: "${secretKey}"`,
    '',
    'access:',
    '  api-keys:',
    `    - "${apiKey}"`,
    '',
    'plugins:',
    '  enabled: true',
    `  dir: "${usePluginsDir}"`,
    '  configs:',
    '    workbuddy:',
    '      enabled: true',
    /**
     * ⚠️ **登录区域必须显式指定**，否则插件默认走国际区（Global）。
     *
     * 国际区签发的登录链接是 `codebuddy.ai`，国内账号在那上面登不进去；
     * 国内区是 `copilot.tencent.com`（`platform=CLI`）。反过来也一样：
     * 在 `.ai` 上签发的 state 拿到 `.cn` 页面会被拒（HTTP 400）。
     *
     * 本项目面向的是国内 WorkBuddy / CodeBuddy 账号（原来那份 v0.9.89 就是 CN 版，
     * 模型前缀 `wb/`；这个新插件国内区用 `cn/` 前缀），所以默认 `cn`。
     * 要登国际账号就改成 `intl`，或者用 `--oauth-region intl` 装。
     */
    `      oauth_region: ${oauthRegion}`,
    '      checkin_auto: true',
    '',
    'routing:',
    '  retry:',
    '    request-retry: 0',
    '',
  ].join('\n')
}

/** base62 随机串，避免任何 shell / yaml 转义问题。 */
function randomSecret(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length]
  return out
}

/** 进度条。只在 TTY 上画，管道里就安静点。 */
function makeProgress() {
  if (process.stdout.isTTY !== true) return undefined
  let lastAt = 0
  return (received, total) => {
    const now = Date.now()
    if (now - lastAt < 120 && received !== total) return
    lastAt = now
    const pct = total > 0 ? Math.floor((received / total) * 100) : 0
    process.stdout.write(`\r    ${String(pct)}%  ${(received / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB`)
    if (received === total) process.stdout.write('\n')
  }
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

const interactive = hasFlag('yes') !== true && hasFlag('download') !== true &&
  ['port', 'api-key', 'secret-key'].every((name) => hasFlag(name) !== true)

async function main() {
  const existingCpa = detectExistingCpa()
  const portProbe = await portInUse(Number(flag('port') ?? 8317))
  const reuseExisting = hasFlag('reuse') === true
  const forceInstall = hasFlag('download') === true || hasFlag('force') === true

  say('')
  say('BuddyKey · 上游安装器')
  say('──────────────────────────────────────────────')
  say(`平台 ${PLAT.os}/${PLAT.arch}　目标目录 ${path.relative(ROOT, CPA_DIR)}`)
  if (interactive !== true) say('非交互模式：用 --port / --api-key / --secret-key / --yes 里的值，其余取默认。')

  if (existingCpa.length > 0 && forceInstall !== true) {
    say('')
    say('发现本机已有 CPA：')
    for (const item of existingCpa) {
      say(`  ${item.dir}`)
      say(
        `    配置 ${item.hasConfig ? '✓' : '✗'}　插件 ${item.plugins.length} 个` +
          `${item.plugins.length > 0 ? '（' + item.plugins.join(', ') + '）' : ''}`,
      )
    }
    if (portProbe.listening === true) say(`  而且端口 8317 已在响应（HTTP ${String(portProbe.status ?? '?')}）。`)
    say('')
    say('默认不动它 —— 别人的 CPA 里可能有别的渠道和账号。')
    say('要装一份本项目专用的，加 --download；要复用已有的，加 --reuse。')
  }

  const source = interactive === true ? createLineSource() : null
  const pick = async (question, flagName, fallback) => {
    const fromFlag = flag(flagName)
    if (fromFlag !== undefined) return fromFlag
    if (source === null) return fallback ?? ''
    return await ask(source, question, fallback)
  }

  try {
    const reuse =
      reuseExisting === true ||
      (existingCpa.length > 0 &&
        forceInstall !== true &&
        (await pick('复用上面这份 CPA？(Y/n)', 'reuse-answer', 'Y')).toLowerCase().startsWith('y') !== false)

    let cpaHome
    let pluginsDirName = 'plugins'

    if (reuse === true && existingCpa.length > 0) {
      const item = existingCpa[0]
      cpaHome = item.dir
      say(`\n复用 ${cpaHome}`)
      const keys = readCpaKeys(path.join(cpaHome, 'config.yaml'))
      if (keys.apiKey === '') warn('读不到 access.api-keys，稍后要手填上游 key。')
      if (keys.secretIsHashed === true) {
        warn('那份 config.yaml 的 management.secret-key 是 bcrypt 哈希，读不出明文。')
        warn('要用你当初设的原值；忘了就在那份 CPA 的面板里重置一个。')
      }
      const port = await pick('CPA 端口', 'port', '8317')
      writeState({
        mode: 'reuse',
        cpaHome,
        port: Number(port) || 8317,
        apiKey: keys.apiKey,
        secretKey: keys.secretKey,
      })
      /** 复用的那份不归我们管，所以没有「装的 tag」可记 —— 留空，页面会显示「未知」。 */
    } else {
      cpaHome = CPA_DIR

      /* ── 1. CPA 本体 ── */
      step(1, 'CPA 本体')
      const already = sourcePresent('cpa')
      if (already === true && hasFlag('force') !== true) {
        const installed = readInstalled('cpa')
        say(`  已有 cli-proxy-api${PLAT.exe}，跳过下载${installed === undefined ? '' : `（装的 ${installed.tag}）`}`)
      } else {
        const outcome = await installSource('cpa', {
          force: hasFlag('force') === true,
          onStep: (phase, detail) => {
            if (phase === 'query') say('  查询 router-for-me/CLIProxyAPI 最新 release…')
            if (phase === 'download') say(`  下载 ${String(detail.name)}（${((detail.size ?? 0) / 1048576).toFixed(1)} MB）`)
            if (phase === 'progress') makeProgress()?.(detail.received ?? 0, detail.total ?? 0)
            if (phase === 'verify-skipped') warn('上游没给 sha256 digest，本次跳过校验')
          },
        })
        if (outcome.ok !== true) {
          process.stderr.write(`\nCPA 本体安装失败（${String(outcome.phase)}）：${String(outcome.error)}\n`)
          process.exitCode = 1
          return
        }
        if (outcome.reused !== true) {
          say(`  解出 ${path.relative(ROOT, path.join(CPA_DIR, `cli-proxy-api${PLAT.exe}`))}（${outcome.tag}）`)
        }
      }

      /* ── 2. workbuddy 插件 ── */
      step(2, 'workbuddy 渠道插件')
      if (sourcePresent('plugins') === true && hasFlag('force') !== true) {
        const installed = readInstalled('plugins')
        say(`  已有 workbuddy${PLAT.lib}，跳过下载${installed === undefined ? '' : `（装的 ${installed.tag}）`}`)
      } else {
        const outcome = await installSource('plugins', {
          force: hasFlag('force') === true,
          onStep: (phase, detail) => {
            if (phase === 'query') say('  从官方插件商店查 workbuddy…')
            if (phase === 'download') say(`  下载 ${String(detail.name)}（${((detail.size ?? 0) / 1048576).toFixed(1)} MB）`)
            if (phase === 'progress') makeProgress()?.(detail.received ?? 0, detail.total ?? 0)
            if (phase === 'verify-skipped') warn('上游没给 sha256 digest，本次跳过校验')
          },
        })
        if (outcome.ok !== true) {
          process.stderr.write(`\n插件安装失败（${String(outcome.phase)}）：${String(outcome.error)}\n`)
          process.exitCode = 1
          return
        }
        if (outcome.reused !== true) {
          say(`  解出 ${path.relative(ROOT, path.join(PLUGIN_DIR, `workbuddy${PLAT.lib}`))}（${outcome.tag}）`)
        }
      }

      /* ── 3. 配置 ── */
      step(3, 'CPA 配置')
      const port = await pick('CPA 端口（BuddyKey 会连它）', 'port', '8317')
      const apiKey = await pick('上游 API key（BuddyKey 拿它调 CPA）', 'api-key', randomSecret(24))
      const secretKey = await pick('管理密钥（BuddyKey 拿它读账号/登录）', 'secret-key', randomSecret(32))

      /**
       * 登录区域：`cn` = 国内（copilot.tencent.com），`intl` = 国际（codebuddy.ai）。
       * 装的时候就要定下来 —— 两者签发的 state 不通用，登录完再改需要重新授权。
       */
      const oauthRegion = await pick('登录区域（cn=国内 / intl=国际）', 'oauth-region', 'cn')
      if (oauthRegion !== 'cn' && oauthRegion !== 'intl') {
        warn(`不认识的登录区域 "${oauthRegion}"，按 cn 处理。`)
      }
      const regionValue = oauthRegion === 'intl' ? 'intl' : 'cn'

      if (fs.existsSync(CPA_CONFIG)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const backup = `${CPA_CONFIG}.bak-${stamp}`
        fs.copyFileSync(CPA_CONFIG, backup)
        say(`  已备份旧配置 ${path.relative(ROOT, backup)}`)
      }
      writeFileAtomic(
        CPA_CONFIG,
        buildCpaConfig({
          port: Number(port) || 8317,
          apiKey,
          secretKey,
          usePluginsDir: pluginsDirName,
          oauthRegion: regionValue,
        }),
      )
      say(`  写入 ${path.relative(ROOT, CPA_CONFIG)}`)
      say(
        `    server.port=${String(port)}　access.api-keys=[${apiKey.slice(0, 6)}…]　` +
          `management.secret-key=[${String(secretKey.length)} 字符]`,
      )
      say(
        `    oauth_region=${regionValue}（${
          regionValue === 'cn' ? '国内，登录走 copilot.tencent.com' : '国际，登录走 codebuddy.ai'
        }）`,
      )

      writeState({
        mode: 'install',
        cpaHome,
        port: Number(port) || 8317,
        apiKey,
        secretKey,
      })
    }

    /* ── 4. BuddyKey 配置 ── */
    step(4, 'BuddyKey 配置')
    const buddyPort = await pick('BuddyKey 监听端口', 'buddy-port', '8318')
    const buddyConfigFile = path.join(ROOT, 'data', 'config.json')
    const current = readJsonFile(buddyConfigFile, {})
    const state = readState()
    const next = {
      ...readJsonFile(path.join(ROOT, 'config.sample.json'), {}),
      ...current,
      upstream: `http://127.0.0.1:${String(state.port ?? 8317)}`,
      upstreamKey: state.apiKey ?? '',
      adminKey: state.secretKey ?? '',
      port: Number(buddyPort) || 8318,
    }
    fs.mkdirSync(path.dirname(buddyConfigFile), { recursive: true })
    if (fs.existsSync(buddyConfigFile)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      fs.copyFileSync(buddyConfigFile, `${buddyConfigFile}.bak-${stamp}`)
    }
    writeFileAtomic(buddyConfigFile, `${JSON.stringify(next, null, 2)}\n`)
    say(`  写入 ${path.relative(ROOT, buddyConfigFile)}`)
    say(`    upstream=${next.upstream}`)
    say(
      `    upstreamKey ${next.upstreamKey === '' ? '空（要补）' : '已填'}　` +
        `adminKey ${next.adminKey === '' ? '空（要补）' : '已填'}`,
    )

    /* ── 5. 下一步 ── */
    say('')
    say('完成。接下来：')
    say('  1. npm run cpa        起 CPA（新窗口，别关）')
    say('  2. npm start          起 BuddyKey')
    say(`  3. 打开 http://127.0.0.1:${String(next.port)}/ ，点「登录 WorkBuddy 账号」扫码 —— 这一步只能你本人做`)
    say('  4. 回页面创建 API key，拿它调 /v1')
    say('')
    say('装的是哪个版本已记进 runtime/install.json；页面会显示「上游有没有新版」，')
    say('要换版本在那点一下，不会自动升级（上游随时可能改行为）。')
    say('')
    if ((next.upstreamKey ?? '') === '' || (next.adminKey ?? '') === '') {
      warn('config.json 里还有空密钥，双方都跑起来也连不通。补齐后重跑本脚本，或手填。')
      process.exitCode = 2
    }
  } finally {
    if (source !== null) source.close()
  }
}

main().catch((error) => {
  process.stderr.write(`\n安装失败：${String(error?.message ?? error)}\n`)
  process.exitCode = 1
})

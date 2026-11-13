/**
 * 一条命令把「上游那一层」装到项目里：CPA 本体 + workbuddy 插件 + config.yaml。
 *
 * 为什么要有这个文件：BuddyKey 只是网关层，它前面必须有 CPA 在跑、
 * 且装好 workbuddy 渠道插件。原来这两样是「使用者自己想办法」——
 * 于是「拉下来就能用」实际只对已经折腾过 CPA 的人成立。
 * 现在把这段自动化掉，只留下「登录账号」这一步必须人来做（扫码）。
 *
 * 三条设计原则：
 *   1. **不碰别人的 CPA**。若探测到 8317 上已有 CPA 在跑、或本机已有
 *      `~/.dsh/cpa-panel/runtime/cpa`，默认走「复用」，只问端口与密钥，
 *      绝不覆盖、不卸载、不动别人的 config。
 *   2. **只下官方来源，且校验 sha256**。CPA 取自 `router-for-me/CLIProxyAPI`，
 *      插件取自官方插件商店 registry 指向的 release。两者都先比 sha256 再落盘，
 *      校验不过就当没下过。
 *   3. **幂等**。重复跑不会重复下载（已有且校验通过就跳过），
 *      config.yaml 已存在就备份后覆盖，端口被占就报清楚。
 *
 * 目录约定：全部落在 `<项目>/runtime/cpa/`（已 gitignore），
 * 与 `data/`、`bin/` 同级 —— 删这个目录 = 卸掉上游，不影响 BuddyKey 自身。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { extractZip } from './zip.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const RUNTIME_DIR = path.join(ROOT, 'runtime')
const CPA_DIR = path.join(RUNTIME_DIR, 'cpa')
const PLUGIN_DIR = path.join(CPA_DIR, 'plugins')
const CPA_CONFIG = path.join(CPA_DIR, 'config.yaml')
const DOWNLOAD_DIR = path.join(RUNTIME_DIR, 'downloads')
const STATE_FILE = path.join(RUNTIME_DIR, 'install.json')

const CPA_REPO = 'router-for-me/CLIProxyAPI'
const PLUGIN_REGISTRY_REPO = 'router-for-me/CLIProxyAPI-Plugins-Store'
const PLUGIN_ID = 'workbuddy'

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
 * 理由同 tools/setup.mjs：探测/下载之间要 await，管道喂答案时
 * `rl.question` 会在 stdin 读完后 reject（readline was closed）。
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

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/** 平台标识，与 CPA 与插件 release 的资产命名对齐。 */
function platformTag() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? '386' : 'amd64'
  if (process.platform === 'win32') return { os: 'windows', arch, exe: '.exe', dll: '.dll' }
  if (process.platform === 'darwin') return { os: 'darwin', arch, exe: '', dll: '.dylib' }
  return { os: 'linux', arch, exe: '', dll: '.so' }
}

/* ─────────────────────────── GitHub 访问 ─────────────────────────── */

/**
 * 走 `api.github.com` 而不是 `github.com`。
 *
 * ⚠️ 实测教训：在很多网络里 `github.com:443` 的 TLS 会被阻断（TCP 能连、握手超时），
 *   而 `api.github.com` 正常。release 的 browser_download_url 指向 github.com，
 *   直接下会卡死；改用 `GET /releases/assets/:id` + `Accept: application/octet-stream`，
 *   这条走 api 域，能过。
 */
const GH_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'buddykey-installer',
  ...(typeof process.env.GITHUB_TOKEN === 'string' && process.env.GITHUB_TOKEN !== ''
    ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}),
}

async function ghJson(url) {
  const response = await fetch(url, { headers: GH_HEADERS })
  if (response.ok !== true) {
    const text = await response.text().catch(() => '')
    throw new Error(`GitHub API ${String(response.status)}：${url}\n${text.slice(0, 200)}`)
  }
  return await response.json()
}

/** 按名字挑资产；优先信任 API 给的 digest，没有再退回同目录的 checksums.txt。 */
function pickAsset(release, pattern) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const matched = assets.filter((asset) => pattern.test(asset.name))
  if (matched.length === 0) {
    throw new Error(
      `release ${String(release?.tag_name)} 里没有匹配 ${String(pattern)} 的资产；` +
        `现有：${assets.map((a) => a.name).join(', ')}`,
    )
  }
  return matched[0]
}

async function downloadAsset(asset, onProgress) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true })
  const target = path.join(DOWNLOAD_DIR, asset.name)
  const response = await fetch(`https://api.github.com/repos/${asset.__repo}/releases/assets/${String(asset.id)}`, {
    headers: { ...GH_HEADERS, accept: 'application/octet-stream' },
  })
  if (response.ok !== true) {
    throw new Error(`下载 ${asset.name} 失败：HTTP ${String(response.status)}`)
  }
  const total = Number(response.headers.get('content-length') ?? asset.size ?? 0)
  const chunks = []
  let received = 0
  for await (const chunk of response.body) {
    chunks.push(chunk)
    received += chunk.length
    if (onProgress !== undefined) onProgress(received, total)
  }
  const buffer = Buffer.concat(chunks)
  if (typeof asset.size === 'number' && buffer.length !== asset.size) {
    throw new Error(`${asset.name} 大小不符：期望 ${String(asset.size)}，实到 ${String(buffer.length)}`)
  }
  return { buffer, path: target }
}

/** 校验并落盘。校验不过直接抛，不留下半成品。 */
function verifyAndSave(buffer, asset, targetPath) {
  const digest = typeof asset.digest === 'string' ? asset.digest.replace(/^sha256:/, '') : ''
  if (digest === '') {
    warn(`${asset.name} 没有官方 digest，跳过校验（GitHub 未提供）`)
  } else {
    const actual = sha256(buffer)
    if (actual !== digest) {
      throw new Error(`${asset.name} sha256 不符\n  期望 ${digest}\n  实际 ${actual}`)
    }
    say(`    sha256 ✓ ${actual.slice(0, 16)}…`)
  }
  writeFileAtomic(targetPath, buffer)
  return targetPath
}

/* ────────────────────────── 已有环境探测 ────────────────────────── */

/**
 * 端口上有没有东西在服务。
 *
 * ⚠️ 不能靠 `error.message` 判断：Node 的 fetch 在连接被拒时抛的是
 *   `TypeError: fetch failed`，`ECONNREFUSED` 藏在 `error.cause.code` 里。
 *   只看 message 会把「没人在听」误判成「已占用」（踩过）。
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
    const exe = path.join(dir, `cli-proxy-api${platformTag().exe}`)
    if (fs.existsSync(exe)) {
      found.push({
        dir,
        exe,
        hasConfig: fs.existsSync(path.join(dir, 'config.yaml')),
        plugins: fs.existsSync(path.join(dir, 'plugins'))
          ? fs.readdirSync(path.join(dir, 'plugins')).filter((name) => /\.(dll|so|dylib)$/i.test(name))
          : [],
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
 * 刻意不抄 config.example.yaml：那份有 85 KB、涵盖所有渠道与实验开关，
 * 抄过来等于把一堆与本项目无关的东西塞给用户。这里只写非它不可的字段，
 * 其余交给 CPA 的默认值。
 */
function buildCpaConfig({ port, apiKey, secretKey, usePluginsDir }) {
  const lines = [
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
    '      checkin_auto: true',
    '',
    'routing:',
    '  retry:',
    '    request-retry: 0',
    '',
  ]
  return lines.join('\n')
}

/** 生成一串够长的随机密钥。base62，避免任何 shell / yaml 转义问题。 */
function randomSecret(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length]
  return out
}

/* ────────────────────────────── 主流程 ────────────────────────────── */

const plat = platformTag()
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
  say(`平台 ${plat.os}/${plat.arch}　目标目录 ${path.relative(ROOT, CPA_DIR)}`)
  if (interactive !== true) say('非交互模式：用 --port / --api-key / --secret-key / --yes 里的值，其余取默认。')

  /* ── 0. 先看这台机器上有没有现成的 CPA ── */
  say('')
  if (existingCpa.length > 0 && forceInstall !== true) {
    say('发现本机已有 CPA：')
    for (const item of existingCpa) {
      say(`  ${item.dir}`)
      say(`    配置 ${item.hasConfig ? '✓' : '✗'}　插件 ${item.plugins.length} 个${item.plugins.length > 0 ? '（' + item.plugins.join(', ') + '）' : ''}`)
    }
    if (portProbe.listening === true) say(`  而且 ${String(portProbe.status ?? '?')} 端口 8317 已在响应。`)
    say('')
    say('默认不动它 —— 别人的 CPA 里可能有别的渠道和账号。')
    say('要装一份本项目专用的，加 --download；要复用已有的，加 --reuse。')
    if (forceInstall !== true && reuseExisting !== true) {
      say('')
      say('（下面对话只用来决定 BuddyKey 连哪一份。）')
    }
  }

  const source = interactive === true ? createLineSource() : null
  const pick = async (question, flagName, fallback) => {
    const fromFlag = flag(flagName)
    if (fromFlag !== undefined) return fromFlag
    if (source === null) return fallback ?? ''
    return await ask(source, question, fallback)
  }

  try {
    const reuse = reuseExisting === true || (existingCpa.length > 0 && forceInstall !== true &&
      (await pick('复用上面这份 CPA？(Y/n)', 'reuse-answer', 'Y')).toLowerCase().startsWith('y') !== false)

    let cpaExe
    let pluginsDirName
    let cpaHome

    if (reuse === true && existingCpa.length > 0) {
      cpaHome = existingCpa[0].dir
      cpaExe = existingCpa[0].exe
      pluginsDirName = 'plugins'
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
        cpaExe,
        port: Number(port),
        apiKey: keys.apiKey,
        secretKey: keys.secretKey,
      })
    } else {
      /* ── 1. 下载并解出 CPA 本体 ── */
      cpaHome = CPA_DIR
      pluginsDirName = 'plugins'
      const exeName = `cli-proxy-api${plat.exe}`
      cpaExe = path.join(CPA_DIR, exeName)

      step(1, 'CPA 本体')
      const already = fs.existsSync(cpaExe)
      if (already === true && hasFlag('force') !== true) {
        say(`  已有 ${path.relative(ROOT, cpaExe)}（${String(Math.round(fs.statSync(cpaExe).size / 1048576))} MB），跳过下载`)
      } else {
        say(`  查询 ${CPA_REPO} 最新 release…`)
        const release = await ghJson(`https://api.github.com/repos/${CPA_REPO}/releases/latest`)
        say(`  版本 ${String(release.tag_name)}（${String(release.published_at).slice(0, 10)}）`)
        const asset = pickAsset(release, new RegExp(`_${plat.os}_${plat.arch}\\.zip$`, 'i'))
        asset.__repo = CPA_REPO
        say(`  下载 ${asset.name}（${(asset.size / 1048576).toFixed(1)} MB）`)
        const { buffer } = await downloadAsset(asset, makeProgress())
        say('')
        const entries = extractZip(buffer)
        const exeEntry = [...entries.keys()].find((name) => name.endsWith(exeName) || name.endsWith(`cli-proxy-api`))
        if (exeEntry === undefined) {
          throw new Error(`CPA 包里没有 ${exeName}；实际内容：${[...entries.keys()].join(', ')}`)
        }
        const exeBytes = entries.get(exeEntry)
        writeFileAtomic(cpaExe, exeBytes, 0o755)
        say(`  解出 ${path.relative(ROOT, cpaExe)}（${String(Math.round(exeBytes.length / 1048576))} MB）`)
        /** 顺手把 README / LICENSE 也放进去 —— 分发别人的二进制要带上许可证。 */
        for (const name of ['LICENSE', 'README.md', 'README_CN.md', 'config.example.yaml']) {
          if (entries.has(name)) writeFileAtomic(path.join(CPA_DIR, name), entries.get(name))
        }
      }

      /* ── 2. 下载并解出 workbuddy 插件 ── */
      step(2, 'workbuddy 渠道插件')
      const pluginName = `workbuddy${plat.dll}`
      const pluginPath = path.join(PLUGIN_DIR, pluginName)
      const pluginOk = fs.existsSync(pluginPath)
      if (pluginOk === true && hasFlag('force') !== true) {
        say(`  已有 ${path.relative(ROOT, pluginPath)}，跳过下载`)
      } else {
        say(`  从官方插件商店查 ${PLUGIN_ID}…`)
        const registry = await fetchRegistry()
        const entry = registry.plugins.find((item) => item.id === PLUGIN_ID)
        if (entry === undefined) throw new Error(`插件商店里没有 ${PLUGIN_ID}`)
        say(`  ${entry.name} v${entry.version}（${entry.author}）`)
        const release = await ghJson(`https://api.github.com/repos/${entry.author}/${path.basename(entry.repository)}/releases/latest`)
        const asset = pickAsset(release, new RegExp(`^${PLUGIN_ID}_.*_${plat.os}_${plat.arch}\\.zip$`, 'i'))
        asset.__repo = `${entry.author}/${path.basename(entry.repository)}`
        say(`  下载 ${asset.name}（${(asset.size / 1048576).toFixed(1)} MB）`)
        const { buffer } = await downloadAsset(asset, makeProgress())
        say('')
        const entries = extractZip(buffer)
        const dllEntry = [...entries.keys()].find((name) => /\.(dll|so|dylib)$/i.test(name))
        if (dllEntry === undefined) throw new Error(`插件包里没有动态库；实际内容：${[...entries.keys()].join(', ')}`)
        fs.mkdirSync(PLUGIN_DIR, { recursive: true })
        writeFileAtomic(pluginPath, entries.get(dllEntry), 0o755)
        say(`  解出 ${path.relative(ROOT, pluginPath)}（${String(Math.round(fs.statSync(pluginPath).size / 1048576))} MB）`)
      }

      /* ── 3. 生成配置 ── */
      step(3, 'CPA 配置')
      const port = await pick('CPA 端口（BuddyKey 会连它）', 'port', '8317')
      const apiKey = await pick('上游 API key（BuddyKey 拿它调 CPA）', 'api-key', randomSecret(24))
      const secretKey = await pick('管理密钥（BuddyKey 拿它读账号/登录）', 'secret-key', randomSecret(32))

      if (fs.existsSync(CPA_CONFIG)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const backup = `${CPA_CONFIG}.bak-${stamp}`
        fs.copyFileSync(CPA_CONFIG, backup)
        say(`  已备份旧配置 ${path.relative(ROOT, backup)}`)
      }
      writeFileAtomic(
        CPA_CONFIG,
        buildCpaConfig({ port: Number(port) || 8317, apiKey, secretKey, usePluginsDir: pluginsDirName }),
      )
      say(`  写入 ${path.relative(ROOT, CPA_CONFIG)}`)
      say(`    server.port=${port}　access.api-keys=[${apiKey.slice(0, 6)}…]　management.secret-key=[${String(secretKey.length)} 字符]`)

      writeState({
        mode: 'install',
        cpaHome: CPA_DIR,
        cpaExe,
        port: Number(port) || 8317,
        apiKey,
        secretKey,
        plugin: pluginName,
      })
    }

    /* ── 4. 把结论写进 BuddyKey 的 config.json ── */
    step(4, 'BuddyKey 配置')
    const buddyPort = await pick('BuddyKey 监听端口', 'buddy-port', '8318')
    const buddyConfigFile = path.join(ROOT, 'data', 'config.json')
    const current = readJsonFile(buddyConfigFile, {})
    const state = readJsonFile(STATE_FILE, {})
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
    say(`    upstreamKey ${next.upstreamKey === '' ? '空（要补）' : '已填'}　adminKey ${next.adminKey === '' ? '空（要补）' : '已填'}`)

    /* ── 5. 下一步 ── */
    say('')
    say('完成。接下来：')
    say(`  1. npm run cpa        起 CPA（新窗口，别关）`)
    say(`  2. npm start          起 BuddyKey`)
    say(`  3. 打开 http://127.0.0.1:${String(next.port)}/ ，点「登录 WorkBuddy 账号」扫码 —— 这一步只能你本人做`)
    say(`  4. 回页面创建 API key，拿它调 /v1`)
    say('')
    if ((next.upstreamKey ?? '') === '' || (next.adminKey ?? '') === '') {
      warn('config.json 里还有空密钥，双方都跑起来也连不通。补齐后重跑本脚本，或手填。')
      process.exitCode = 2
    }
  } finally {
    if (source !== null) source.close()
  }
}

/* ──────────────────────────── 辅助 ──────────────────────────── */

function writeState(value) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  writeFileAtomic(STATE_FILE, `${JSON.stringify({ ...value, at: new Date().toISOString() }, null, 2)}\n`)
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

async function fetchRegistry() {
  const response = await fetch(
    `https://api.github.com/repos/${PLUGIN_REGISTRY_REPO}/contents/registry.json`,
    { headers: GH_HEADERS },
  )
  if (response.ok !== true) throw new Error(`拉插件商店 registry 失败：HTTP ${String(response.status)}`)
  const body = await response.json()
  const text = Buffer.from(body.content, 'base64').toString('utf8')
  return JSON.parse(text)
}

main().catch((error) => {
  process.stderr.write(`\n安装失败：${String(error?.message ?? error)}\n`)
  process.exitCode = 1
})

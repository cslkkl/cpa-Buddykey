/**
 * 上游（CPA 本体 / workbuddy 插件）的**下载、校验、解压、替换**。
 *
 * 这个文件是从 `tools/install-cpa.mjs` 抽出来的第二半：让「首次安装」与「强制更新」
 * 走**同一份**下载与校验代码。参考实现在决策记录里写死过这条理由 ——
 * 强制更新若在外面重写一遍「查 release → 下载 → 校验 → 解压」，
 * **第一件被漏掉的通常就是 sha256 校验**。
 *
 * ## 三条硬口径
 *
 * 1. **绝不覆盖用户已有的安装**：`force: false` 时磁盘上有就原样复用；
 *    要换必须显式 `force: true`（对应页面上那个「更新」按钮）。
 * 2. **校验 sha256 后才解压**：网络下载的东西不能盲信。上游没给 digest 时
 *    跳过并**如实报告 `verified: false`**，不假装校验过。
 * 3. **替换先备份、失败还原**：中途任何一步失败都必须能把旧件放回，
 *    否则一次网络抖动就换来一个空目录 —— 用户看到的是「渠道全没了」。
 *
 * ## 为什么这里不自动停 CPA
 *
 * 参考实现把「停 CPA」放在上层（`ops/plugin-update.ts`）而不是安装层，
 * 理由是 Windows 上被加载的 dll 改不了名。BuddyKey 的情况更进一步：
 * **CPA 不是它启动的**，所以它连「停」都做不到 —— 只能检测到 CPA 在跑、
 * 然后在备份失败时如实说「先把 CPA 停了」。不做越权的事。
 *
 * @module buddykey/tools/upstream
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { extractZip } from './zip.mjs'
import { SOURCE_LABELS, resolveSourceKey } from '../lib/update-text.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const RUNTIME_DIR = path.join(ROOT, 'runtime')
const CPA_DIR = path.join(RUNTIME_DIR, 'cpa')
const PLUGIN_DIR = path.join(CPA_DIR, 'plugins')
const DOWNLOAD_DIR = path.join(RUNTIME_DIR, 'downloads')
const STATE_FILE = path.join(RUNTIME_DIR, 'install.json')

const CPA_REPO = 'router-for-me/CLIProxyAPI'
const PLUGIN_REGISTRY_REPO = 'router-for-me/CLIProxyAPI-Plugins-Store'
const PLUGIN_ID = 'workbuddy'

/** 平台标识，与两个 release 的资产命名对齐。 */
export function platformTag() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? '386' : 'amd64'
  if (process.platform === 'win32') return { os: 'windows', arch, exe: '.exe', lib: '.dll' }
  if (process.platform === 'darwin') return { os: 'darwin', arch, exe: '', lib: '.dylib' }
  return { os: 'linux', arch, exe: '', lib: '.so' }
}

const PLAT = platformTag()

/**
 * 两个来源的定位信息。
 *
 * `exclusiveDir` = 这个来源**独占**落点目录，替换时必须先清空再解压。
 * 插件的目录是独占的：上游若删掉某个渠道，直接覆盖解压会留下上一版的 dll，
 * 而 CPA 按「磁盘上有什么就加载什么」，于是去加载一个已被撤掉的插件（参考实现踩过）。
 * CPA 本体的目录**不是**独占的 —— `config.yaml` 与 `plugins/` 与 exe 同层，
 * 清空等于顺手删掉用户的配置与插件。
 */
export function sourceOf(key) {
  if (key === 'cpa') {
    return {
      key,
      label: SOURCE_LABELS.cpa,
      repo: CPA_REPO,
      assetPattern: new RegExp(`_${PLAT.os}_${PLAT.arch}\\.zip$`, 'i'),
      targetDir: CPA_DIR,
      exeName: `cli-proxy-api${PLAT.exe}`,
      exclusiveDir: false,
    }
  }
  return {
    key: 'plugins',
    label: SOURCE_LABELS.plugins,
    /** 插件仓库要现查 registry 才知道，见 `resolvePluginRepo()`。 */
    repo: '',
    assetPattern: new RegExp(`^${PLUGIN_ID}_.*_${PLAT.os}_${PLAT.arch}\\.zip$`, 'i'),
    targetDir: PLUGIN_DIR,
    exeName: `${PLUGIN_ID}${PLAT.lib}`,
    exclusiveDir: true,
  }
}

/* ────────────────────────────── 安装记录 ────────────────────────────── */

/**
 * 读某个来源的安装记录。
 *
 * 返回 `undefined` = **不知道**（没记过 / 文件坏了 / 形状不对），
 * 不拿一个编出来的版本号顶上 —— 界面据此显示「未知」，而不是假装已是最新。
 *
 * ⚠️ 每个来源各占一格：整份覆盖会让「刚更新完 cpa」把「plugins 的记录」抹掉。
 */
export function readInstalled(key) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return undefined
  }
  const slots = parsed?.sources
  if (slots === null || typeof slots !== 'object') return undefined
  const entry = slots[key]
  if (entry === null || typeof entry !== 'object') return undefined
  if (typeof entry.tag !== 'string' || entry.tag === '') return undefined
  return {
    tag: entry.tag,
    name: typeof entry.name === 'string' ? entry.name : undefined,
    at: typeof entry.at === 'string' ? entry.at : undefined,
  }
}

/** 记下这次装的是哪个 tag；只动自己那一格。 */
export function rememberInstall(key, entry) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    parsed = {}
  }
  const slots =
    parsed?.sources !== null && typeof parsed?.sources === 'object' ? { ...parsed.sources } : {}
  slots[key] = {
    tag: entry.tag,
    ...(entry.name === undefined || entry.name === '' ? {} : { name: entry.name }),
    at: new Date().toISOString(),
  }
  const next = { ...parsed, sources: slots }
  const tmp = `${STATE_FILE}.tmp-${String(process.pid)}`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, STATE_FILE)
}

/** 整份读 install.json（`install-cpa` 还要用它拿端口与密钥）。 */
export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

/** 整份写 install.json（保留已记的 sources）。 */
export function writeState(value) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  const current = readState()
  const next = { ...current, ...value }
  fs.writeFileSync(`${STATE_FILE}.tmp-${String(process.pid)}`, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  fs.renameSync(`${STATE_FILE}.tmp-${String(process.pid)}`, STATE_FILE)
}

/* ────────────────────────────── 网络 ────────────────────────────── */

/**
 * 一律走 `api.github.com`。
 *
 * ⚠️ 实测：很多网络里 `github.com:443` 的 TLS 被阻断（TCP 通、握手超时），
 *   而 `api.github.com` 正常。release 资产的 `browser_download_url` 指向 github.com，
 *   直接下会卡死 —— 改用 `GET /releases/assets/:id` + `Accept: application/octet-stream`。
 */
const GH_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'buddykey-upstream',
  ...(typeof process.env.GITHUB_TOKEN === 'string' && process.env.GITHUB_TOKEN !== ''
    ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}),
}

async function ghJson(url) {
  const response = await fetch(url, { headers: GH_HEADERS })
  if (response.ok !== true) {
    const text = await response.text().catch(() => '')
    throw new Error(`GitHub API ${String(response.status)}：${url} ${text.slice(0, 160)}`)
  }
  return await response.json()
}

/** 从官方插件商店的 registry 里查 workbuddy 的仓库（原仓库已 404，别硬编码）。 */
let pluginRepoCache
export async function resolvePluginRepo() {
  if (pluginRepoCache !== undefined) return pluginRepoCache
  const response = await fetch(
    `https://api.github.com/repos/${PLUGIN_REGISTRY_REPO}/contents/registry.json`,
    { headers: GH_HEADERS },
  )
  if (response.ok !== true) throw new Error(`拉插件商店 registry 失败：HTTP ${String(response.status)}`)
  const body = await response.json()
  const registry = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'))
  const entry = Array.isArray(registry?.plugins)
    ? registry.plugins.find((item) => item?.id === PLUGIN_ID)
    : undefined
  if (entry === undefined) throw new Error(`插件商店里没有 ${PLUGIN_ID}`)
  const owner = String(entry.author ?? '')
  const repoName = path.basename(String(entry.repository ?? ''))
  if (owner === '' || repoName === '') throw new Error(`${PLUGIN_ID} 条目缺少 author/repository`)
  pluginRepoCache = { repo: `${owner}/${repoName}`, version: entry.version, name: entry.name }
  return pluginRepoCache
}

/** 按模式挑资产。 */
function pickAsset(release, pattern) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const matched = assets.filter((asset) => pattern.test(String(asset?.name ?? '')))
  if (matched.length === 0) {
    throw new Error(
      `release ${String(release?.tag_name)} 里没有匹配 ${String(pattern)} 的资产；` +
        `现有：${assets.map((a) => a.name).join(', ')}`,
    )
  }
  return matched[0]
}

/**
 * 查某个来源的最新资产信息（不下载）。
 *
 * 这是「有没有新版」的数据源：只回答「上游现在是什么 tag / 哪个文件」，
 * 不回答「你那份旧不旧」—— 后者归 `readInstalled`，两条问题各有各的源。
 */
export async function findAsset(key) {
  const source = sourceOf(key)
  let repo = source.repo
  if (repo === '') {
    const plugin = await resolvePluginRepo()
    repo = plugin.repo
  }
  const release = await ghJson(`https://api.github.com/repos/${repo}/releases/latest`)
  const asset = pickAsset(release, source.assetPattern)
  return {
    tag: String(release.tag_name ?? ''),
    name: String(asset.name),
    size: Number(asset.size ?? 0),
    id: Number(asset.id),
    digest: typeof asset.digest === 'string' ? asset.digest : '',
    repo,
  }
}

/** 流式下载到内存；两个包都 < 30 MB，全量持有比临时文件更好收尾。 */
async function downloadAsset(asset, onProgress) {
  const response = await fetch(
    `https://api.github.com/repos/${asset.repo}/releases/assets/${String(asset.id)}`,
    { headers: { ...GH_HEADERS, accept: 'application/octet-stream' } },
  )
  if (response.ok !== true) throw new Error(`下载 ${asset.name} 失败：HTTP ${String(response.status)}`)

  const total = Number(response.headers.get('content-length') ?? asset.size ?? 0)
  const chunks = []
  let received = 0
  for await (const chunk of response.body) {
    chunks.push(chunk)
    received += chunk.length
    onProgress?.(received, total)
  }
  const buffer = Buffer.concat(chunks)
  if (asset.size > 0 && buffer.length !== asset.size) {
    throw new Error(`${asset.name} 大小不符：期望 ${String(asset.size)}，实到 ${String(buffer.length)}`)
  }
  return buffer
}

/**
 * 校验 sha256；上游没给 digest 时跳过并报 `skipped`。
 *
 * ⚠️ 跳过要**如实报出来**（`verified: false`），不能当成校验通过。
 */
function verify(buffer, digest) {
  const expected = String(digest ?? '').replace(/^sha256:/i, '').toLowerCase()
  if (expected === '') return { ok: true, skipped: true }
  const actual = crypto.createHash('sha256').update(buffer).digest('hex')
  if (actual !== expected) return { ok: false, expected, actual }
  return { ok: true, actual }
}

/* ────────────────────────────── 落盘 ────────────────────────────── */

function writeAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${String(process.pid)}`
  fs.writeFileSync(tmp, data)
  if (mode !== undefined) fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, file)
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function backupPathOf(key) {
  return key === 'cpa'
    ? path.join(CPA_DIR, 'cli-proxy-api.bak')
    : path.join(CPA_DIR, 'plugins.bak')
}

/**
 * 把现有产物挪到备份位。
 *
 * - 独占目录的来源：整目录改名 —— 快，且是原子的；
 * - 与配置同层的来源（cpa）：只复制可执行文件，**不能动同层的 config.yaml 与 plugins/**。
 *
 * @returns 备份成功与否（来源本来就不在时算成功，没什么可丢的）。
 */
function makeBackup(key) {
  const source = sourceOf(key)
  const backup = backupPathOf(key)
  try {
    removeDir(backup)
    if (source.exclusiveDir) {
      return fs.existsSync(source.targetDir) ? (fs.renameSync(source.targetDir, backup), true) : true
    }
    const exe = path.join(source.targetDir, source.exeName)
    if (!fs.existsSync(exe)) return true
    fs.copyFileSync(exe, backup)
    return true
  } catch {
    /** 改名失败最常见的原因是**文件被占用**（CPA 还在跑）—— 报出来，别静默。 */
    return false
  }
}

function restoreBackup(key) {
  const source = sourceOf(key)
  const backup = backupPathOf(key)
  try {
    if (!fs.existsSync(backup)) return
    if (source.exclusiveDir) {
      removeDir(source.targetDir)
      fs.renameSync(backup, source.targetDir)
      return
    }
    fs.copyFileSync(backup, path.join(source.targetDir, source.exeName))
  } catch {
    /** 还原也失败时，旧件至少还在 .bak 里；调用方会把这一点说出去。 */
  }
}

function discardBackup(key) {
  removeDir(backupPathOf(key))
}

/** 磁盘上有没有这个来源的东西（宽松判据：只回答「要不要去下一个」）。 */
export function sourcePresent(key) {
  const source = sourceOf(key)
  if (source.exclusiveDir !== true) {
    return fs.existsSync(path.join(source.targetDir, source.exeName))
  }
  try {
    return fs
      .readdirSync(source.targetDir)
      .some((name) => new RegExp(`\\${PLAT.lib}$`, 'i').test(name))
  } catch {
    return false
  }
}

/**
 * 把一个来源装到磁盘上。
 *
 * `force: false` 只补缺件（磁盘上有就原样复用），`force: true` 覆盖替换。
 * 两种模式共用同一条「查 → 下 → 验 → 备份 → 解压 → 记录」的流水线。
 */
export async function installSource(key, options = {}) {
  const source = sourceOf(key)
  const onStep = typeof options.onStep === 'function' ? options.onStep : () => {}

  if (options.force !== true && sourcePresent(key) === true) {
    onStep('reuse')
    return { ok: true, reused: true }
  }

  onStep('query')
  let asset
  try {
    asset = await findAsset(key)
  } catch (error) {
    return { ok: false, phase: 'query', error: String(error?.message ?? error) }
  }

  onStep('download', { name: asset.name, size: asset.size })
  let buffer
  try {
    buffer = await downloadAsset(asset, (received, total) => {
      onStep('progress', { name: asset.name, size: asset.size, received, total })
    })
  } catch (error) {
    return { ok: false, phase: 'download', error: String(error?.message ?? error) }
  }

  const check = verify(buffer, asset.digest)
  if (check.ok !== true) {
    onStep('verify')
    return {
      ok: false,
      phase: 'verify',
      error: `sha256 不匹配（期望 ${check.expected}，实际 ${check.actual}）`,
    }
  }
  if (check.skipped === true) onStep('verify-skipped')

  let entries
  try {
    entries = extractZip(buffer)
  } catch (error) {
    return { ok: false, phase: 'extract', error: String(error?.message ?? error) }
  }

  /**
   * ⚠️ 备份只在**覆盖替换**时做。首次安装（目录里什么都没有）没有可丢的东西，
   *   备份只会白复制一份 8 MB。
   */
  const replacing = options.force === true && sourcePresent(key) === true
  if (replacing === true) {
    onStep('backup')
    if (makeBackup(key) !== true) {
      return {
        ok: false,
        phase: 'backup',
        error: '旧件挪不开（多半是 CPA 还在运行、插件被占用）。先停掉 CPA 再来。',
      }
    }
  }

  /** 独占目录的来源：先清空再解压，否则上一版的残留 dll 会被 CPA 当成现行插件加载。 */
  if (source.exclusiveDir === true && fs.existsSync(source.targetDir)) {
    onStep('clear')
    if (removeDir(source.targetDir) !== true) {
      if (replacing === true) restoreBackup(key)
      return { ok: false, phase: 'clear', error: '清不掉旧目录（文件被占用）' }
    }
  }

  onStep('extract')
  try {
    fs.mkdirSync(source.targetDir, { recursive: true })
    if (key === 'cpa') {
      /** CPA 包里除了 exe 还有 LICENSE 与 README —— 分发别人的二进制要带上许可证。 */
      for (const [name, data] of entries) {
        const target = name.endsWith(source.exeName) ? path.join(source.targetDir, source.exeName) : path.join(source.targetDir, path.basename(name))
        writeAtomic(target, data, name.endsWith('.exe') ? 0o755 : undefined)
      }
    } else {
      const libEntry = [...entries.entries()].find(([name]) => new RegExp(`\\${PLAT.lib}$`, 'i').test(name))
      if (libEntry === undefined) {
        throw new Error(`插件包里没有动态库；实际内容：${[...entries.keys()].join(', ')}`)
      }
      writeAtomic(path.join(source.targetDir, source.exeName), libEntry[1], 0o755)
    }
  } catch (error) {
    if (replacing === true) restoreBackup(key)
    return { ok: false, phase: 'extract', error: String(error?.message ?? error) }
  }

  if (replacing === true) discardBackup(key)

  rememberInstall(key, { tag: asset.tag, name: asset.name })
  return {
    ok: true,
    tag: asset.tag,
    name: asset.name,
    /** sha256 校验真跑过没有（上游没给 digest 时是 false）。 */
    verified: check.skipped !== true,
  }
}

/**
 * 查「已装的 tag」与「上游最新的 tag」。
 *
 * ⚠️ 没记录过安装 tag 时**不给 `hasUpdate`**（不是 true 也不是 false）：
 *   那时「装的是哪版」根本不知道。编一个 true 会催用户去换可能已经最新的东西；
 *   编 false 则把真话说反。
 */
export async function checkUpdate(rawKey) {
  const key = resolveSourceKey(rawKey)
  if (key === undefined) {
    return { ok: false, reason: 'unknown-source', error: `不认识的来源：${String(rawKey)}` }
  }
  const source = sourceOf(key)

  const installed = readInstalled(key) ?? null

  let latest
  try {
    const asset = await findAsset(key)
    latest = { tag: asset.tag, name: asset.name, size: asset.size }
  } catch (error) {
    /** 查不到上游（断网 / 代理 / 限流）不是「没有新版」，是一句失败。 */
    return { ok: false, reason: 'release-query-failed', error: String(error?.message ?? error) }
  }

  return {
    ok: true,
    key,
    label: source.label,
    installed,
    latest,
    ...(installed === null ? {} : { hasUpdate: installed.tag !== latest.tag }),
    installedPresent: sourcePresent(key),
    checkedAt: new Date().toISOString(),
  }
}

export { ROOT, RUNTIME_DIR, CPA_DIR, PLUGIN_DIR, STATE_FILE, PLAT }

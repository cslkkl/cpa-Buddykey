/**
 * `npm run cpa` —— 起本项目自带的那份 CPA。
 *
 * 只做三件事：找到装好的 CPA、确认它的配置与插件在位、把它拉起来并转发日志。
 * 找不到就明确告诉你先跑 `npm run install-cpa`，不猜、不自己下载。
 *
 * 为什么不直接 `.\runtime\cpa\cli-proxy-api.exe`：
 *   - 要 cd 到它自己的目录（它按相对路径找 config.yaml 与 plugins/）；
 *   - 要把 stdout/stderr 同时印出来，否则「起没起来」全靠猜；
 *   - 要在端口已被占用时说人话，而不是丢一段 EADDRINUSE。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const RUNTIME_STATE = path.join(ROOT, 'runtime', 'install.json')
const DEFAULT_CPA_DIR = path.join(ROOT, 'runtime', 'cpa')

const say = (text = '') => process.stdout.write(`${text}\n`)

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function exeName() {
  return process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api'
}

function dllExt() {
  if (process.platform === 'win32') return '.dll'
  if (process.platform === 'darwin') return '.dylib'
  return '.so'
}

/**
 * 端口上有没有东西在服务。
 *
 * ⚠️ 不能靠 `error.message` 判断：Node 的 fetch 在连接被拒时抛的是
 *   `TypeError: fetch failed`，`ECONNREFUSED` 藏在 `error.cause.code` 里。
 *   只看 message 会把「没人在听」误判成「被占用」，于是明明能起却拒绝启动。
 */
async function portBusy(port) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/models`, { signal: controller.signal })
    clearTimeout(timer)
    return { busy: true, status: response.status }
  } catch (error) {
    const code = error?.cause?.code ?? error?.code ?? ''
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return { busy: false, code }
    if (error?.name === 'AbortError') return { busy: true, code: 'timeout' }
    /** 其它错误按「有人在听但不对劲」处理，宁可让用户手查，也不假装能起。 */
    return { busy: true, code: code === '' ? 'unknown' : code, raw: String(error?.message ?? error) }
  }
}

async function main() {
  const state = readJson(RUNTIME_STATE, {})
  const cpaDir = typeof state.cpaHome === 'string' && state.cpaHome !== '' ? state.cpaHome : DEFAULT_CPA_DIR
  const exe = path.join(cpaDir, exeName())
  const configFile = path.join(cpaDir, 'config.yaml')
  const pluginDir = path.join(cpaDir, 'plugins')
  const pluginFile = path.join(pluginDir, `workbuddy${dllExt()}`)

  if (fs.existsSync(exe) !== true) {
    say('')
    say(`没找到 CPA：${path.relative(ROOT, exe)}`)
    say('')
    say('这台机器上如果已经有 CPA（比如 ~/.dsh/cpa-panel 里那份），直接用它就行 ——')
    say('跑 `npm run install-cpa -- --reuse`，它会把你现有那份接上 BuddyKey。')
    say('想装一份本项目专用（不影响别处），跑 `npm run install-cpa -- --download`。')
    say('')
    process.exitCode = 1
    return
  }

  if (fs.existsSync(configFile) !== true) {
    say(`缺配置：${path.relative(ROOT, configFile)}`)
    say('跑 `npm run install-cpa` 生成一份。')
    process.exitCode = 1
    return
  }

  const hasPlugin = fs.existsSync(pluginFile)
  const port = Number(state.port ?? 8317) || 8317

  say('')
  say('BuddyKey · CPA')
  say('──────────────────────────────────────────────')
  say(`目录   ${path.relative(ROOT, cpaDir)}`)
  say(`配置   ${fs.existsSync(configFile) ? '✓' : '✗'}`)
  say(`插件   ${hasPlugin ? '✓ workbuddy' : '✗ 缺 workbuddy 插件（渠道会起不来）'}`)
  say(`端口   ${String(port)}`)

  if (hasPlugin !== true) {
    say('')
    say('workbuddy 插件不在位。跑 `npm run install-cpa` 补装，否则这个渠道不会注册。')
  }

  const probe = await portBusy(port)
  if (probe.busy === true) {
    say('')
    say(`端口 ${String(port)} 已经有东西在响应（HTTP ${String(probe.status ?? '?')}）。`)
    say('可能已经有一份 CPA 在跑 —— 那就直接用，不必再起。')
    say('如果那是别的程序，改 runtime/install.json 或 data/config.json 里的端口。')
    process.exitCode = 1
    return
  }

  say('')
  say('启动中… （Ctrl+C 停止）')
  say('')

  /**
   * ⚠️ `cwd` 必须是 CPA 自己的目录：它按相对路径找 `config.yaml` 与 `plugins/`，
   *   在项目根目录起会「启动成功但没有任何渠道」。
   */
  const child = spawn(exe, [], {
    cwd: cpaDir,
    stdio: 'inherit',
    windowsHide: false,
  })

  child.on('error', (error) => {
    say(`起不来：${String(error?.message ?? error)}`)
    process.exitCode = 1
  })
  child.on('exit', (code, signal) => {
    say('')
    say(`CPA 已退出（code=${String(code)}${signal === null ? '' : `, signal=${String(signal)}`}）`)
    process.exitCode = code === null ? 1 : code
  })

  /** Ctrl+C 要转给子进程，否则 Windows 上它会变成孤儿继续占着端口。 */
  const stop = () => {
    if (child.exitCode === null) child.kill('SIGINT')
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((error) => {
  process.stderr.write(`失败：${String(error?.message ?? error)}\n`)
  process.exitCode = 1
})

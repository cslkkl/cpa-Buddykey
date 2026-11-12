/**
 * 假 CPA：只实现 BuddyKey 用到的那些接口，用来验「密钥配好之后」的行为。
 *
 * 为什么需要它：真 CPA 有 IP 级失败封禁，用错密钥测一次就封 30 分钟。
 * 这个桩让「密钥正确 / 密钥错误 / 上游报错」三个分支都能随时复现，
 * 且完全不影响真实账号池。
 *
 * 用法：node tools/fake-cpa.mjs [port]
 */

import http from 'node:http'

const PORT = Number(process.argv[2] ?? 8390)
const ADMIN_KEY = 'fake-admin-key'
const UPSTREAM_KEY = 'fake-upstream-key'

/**
 * 两个假账号，形状对齐真 CPA 的 accounts / credits / auth-files。
 *
 * ⚠️ `disabled` 只存在 FILES 里，`/accounts` 的响应现算 —— 真 CPA 就是这样：
 *   `PATCH /v0/management/auth-files/status` 改了凭据文件，`/accounts` 立刻反映。
 *   桩里如果把 disabled 各存一份，就会出现「auth-files 已停用、accounts 还说启用中」
 *   的假象，把被测代码的正常行为误判成 bug（踩过一次）。
 */
const ACCOUNT_SEEDS = [
  { auth_index: 'aaaa1111bbbb2222', nickname: '假号甲', status: 'active', region: 'cn' },
  { auth_index: 'cccc3333dddd4444', nickname: '假号乙', status: 'active', region: 'cn' },
]
const CREDITS = [
  { auth_index: 'aaaa1111bbbb2222', credits: { total_remain: 1200, total_used: 300, total_size: 1500, pack_count: 2 } },
  { auth_index: 'cccc3333dddd4444', credits: { total_remain: 800, total_used: 200, total_size: 1000, pack_count: 1 } },
]
const FILES = ACCOUNT_SEEDS.map((account, index) => ({
  name: `workbuddy-fake-${String(index)}.json`,
  auth_index: account.auth_index,
  provider: 'workbuddy',
  disabled: false,
}))

/** `/accounts` 的响应：disabled / exhausted 全部从 FILES 现算。 */
function accountsBody() {
  return ACCOUNT_SEEDS.map((seed) => {
    const file = FILES.find((item) => item.auth_index === seed.auth_index)
    return {
      auth_index: seed.auth_index,
      nickname: seed.nickname,
      disabled: file === undefined ? false : file.disabled === true,
      exhausted: false,
      status: seed.status,
      region: seed.region,
    }
  })
}

/** 管理面的失败计数：用来复现 CPA 的 IP 封禁行为。 */
let failedAttempts = 0
let bannedUntil = 0

const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function managementGuard(req, res) {
  const now = Date.now()
  if (now < bannedUntil) {
    const left = Math.ceil((bannedUntil - now) / 1000)
    const minutes = Math.floor(left / 60)
    const seconds = left % 60
    json(res, 403, {
      error: `IP banned due to too many failed attempts. Try again in ${String(minutes)}m${String(seconds)}s`,
    })
    return false
  }
  const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  if (token !== ADMIN_KEY) {
    failedAttempts += 1
    // 桩里把阈值调低（3 次）方便复现，真 CPA 大约是这个量级。
    if (failedAttempts >= 3) {
      bannedUntil = now + 60 * 1000
      failedAttempts = 0
    }
    json(res, 401, { error: 'invalid management key' })
    return false
  }
  failedAttempts = 0
  return true
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${String(PORT)}`)
  const path = url.pathname

  /* ── 数据面：不鉴权管理密钥 ── */
  if (path === '/v1/models') {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
    if (token !== UPSTREAM_KEY) return json(res, 401, { error: { message: 'bad upstream key' } })
    return json(res, 200, { object: 'list', data: [{ id: 'wb/deepseek-v4.1-flash', object: 'model' }] })
  }
  if (path === '/v1/chat/completions' && req.method === 'POST') {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
    if (token !== UPSTREAM_KEY) return json(res, 401, { error: { message: 'bad upstream key' } })
    const body = JSON.parse((await readBody(req)) || '{}')
    const picked = (FILES[Math.floor(Math.random() * FILES.length)])
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-cpa-trace-id': `20261112200000-${picked.auth_index}-fake-request`,
    })
    res.end(
      JSON.stringify({
        id: 'fake-completion',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? 'wb/deepseek-v4.1-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, credit: 0.1 },
      }),
    )
    return
  }

  /* ── 管理面：全部要管理密钥 ── */
  if (path.startsWith('/v0/management/') !== true && path.startsWith('/v8/management/') !== true) {
    return json(res, 404, { error: 'not found' })
  }
  if (managementGuard(req, res) !== true) return undefined

  if (path === '/v0/management/auth-files') return json(res, 200, { files: FILES })
  if (path === '/v0/management/auth-files/status' && req.method === 'PATCH') {
    const body = JSON.parse((await readBody(req)) || '{}')
    const target = FILES.find((file) => file.name === body.name)
    if (target === undefined) return json(res, 404, { error: 'no such file' })
    target.disabled = body.disabled === true
    return json(res, 200, { ok: true })
  }
  if (path.endsWith('/accounts')) {
    return json(res, 200, { accounts: accountsBody(), checkin_auto: false, lifecycle_auto: false })
  }
  if (path.endsWith('/credits')) return json(res, 200, { accounts: CREDITS })
  if (path === '/v8/management/oauth/auth-url') {
    return json(res, 200, { url: 'https://fake.example/oauth?state=fake-state-1', state: 'fake-state-1' })
  }
  if (path === '/v8/management/oauth/status') {
    return json(res, 200, { status: 'done' })
  }
  if (path === '/v8/management/oauth/session' && req.method === 'DELETE') {
    return json(res, 200, { ok: true })
  }
  return json(res, 404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`fake-cpa on http://127.0.0.1:${String(PORT)}\n`)
  process.stdout.write(`  admin key    ${ADMIN_KEY}\n`)
  process.stdout.write(`  upstream key ${UPSTREAM_KEY}\n`)
})

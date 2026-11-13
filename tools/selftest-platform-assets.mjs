/**
 * 自测：各平台的发布包资产能不能被正确选中。
 *
 * 为什么需要它：上游**按平台用了不同容器**——Windows 发 `.zip`，
 * Linux/macOS 发 `.tar.gz`，且 Linux 还多一个 `_no-plugin.tar.gz`（不含插件宿主）。
 * 选错资产的表现是「装完起得来但渠道注册不上」，或直接「没有匹配的资产」。
 * 这类错误只在换到另一个平台时才暴露，所以用一张表把它钉住。
 *
 * 用法：`node tools/selftest-platform-assets.mjs`（已挂进 npm run check）。
 */

/** 与 tools/upstream.mjs 的 platformTag() 同构，但允许指定平台以便一次测全。 */
function platformTagOf(platform, arch) {
  if (platform === 'win32') return { os: 'windows', arch, exe: '.exe', lib: '.dll' }
  if (platform === 'darwin') return { os: 'darwin', arch, exe: '', lib: '.dylib' }
  return { os: 'linux', arch, exe: '', lib: '.so' }
}

/** 与 tools/upstream.mjs 的 archTokenFor() 保持一致 —— 这是本自测的核心。 */
function archTokenFor(key, os, arch) {
  if (arch !== 'arm64') return arch
  /** CPA 在 linux/windows 上写 aarch64，在 darwin 上写 arm64；插件一律 arm64。 */
  if (key === 'cpa' && os !== 'darwin') return 'aarch64'
  return 'arm64'
}

/** 与 sourceOf() 里两个模式保持一致。 */
function patternsFor(plat) {
  return {
    cpa: new RegExp(`_${plat.os}_${archTokenFor('cpa', plat.os, plat.arch)}\\.(zip|tar\\.gz)$`, 'i'),
    plugins: new RegExp(
      `^workbuddy_.*_${plat.os}_${archTokenFor('plugins', plat.os, plat.arch)}\\.(zip|tar\\.gz)$`,
      'i',
    ),
  }
}

const CPA_ASSETS = [
  'CLIProxyAPI_8.0.69_linux_amd64.tar.gz',
  'CLIProxyAPI_8.0.69_linux_amd64_no-plugin.tar.gz',
  'CLIProxyAPI_8.0.69_linux_aarch64.tar.gz',
  'CLIProxyAPI_8.0.69_darwin_amd64.tar.gz',
  'CLIProxyAPI_8.0.69_darwin_arm64.tar.gz',
  'CLIProxyAPI_8.0.69_windows_amd64.zip',
  'CLIProxyAPI_8.0.69_windows_aarch64.zip',
]

const PLUGIN_ASSETS = [
  'workbuddy_0.10.0_linux_amd64.zip',
  'workbuddy_0.10.0_linux_arm64.zip',
  'workbuddy_0.10.0_windows_amd64.zip',
  'workbuddy_0.10.0_windows_arm64.zip',
]

/** 每个平台应当选中哪个（`null` = 那个平台上不该有资产可选）。 */
const EXPECT = [
  { platform: 'linux', arch: 'amd64', cpa: 'CLIProxyAPI_8.0.69_linux_amd64.tar.gz', plugin: 'workbuddy_0.10.0_linux_amd64.zip' },
  { platform: 'linux', arch: 'arm64', cpa: 'CLIProxyAPI_8.0.69_linux_aarch64.tar.gz', plugin: 'workbuddy_0.10.0_linux_arm64.zip' },
  { platform: 'win32', arch: 'amd64', cpa: 'CLIProxyAPI_8.0.69_windows_amd64.zip', plugin: 'workbuddy_0.10.0_windows_amd64.zip' },
  { platform: 'win32', arch: 'arm64', cpa: 'CLIProxyAPI_8.0.69_windows_aarch64.zip', plugin: 'workbuddy_0.10.0_windows_arm64.zip' },
  { platform: 'darwin', arch: 'arm64', cpa: 'CLIProxyAPI_8.0.69_darwin_arm64.tar.gz', plugin: null },
]

const problems = []

for (const row of EXPECT) {
  const plat = platformTagOf(row.platform, row.arch)
  const patterns = patternsFor(plat)
  const cpaHit = CPA_ASSETS.filter((name) => patterns.cpa.test(name))
  const pluginHit = PLUGIN_ASSETS.filter((name) => patterns.plugins.test(name))

  const checkOne = (label, got, want) => {
    if (want === null) {
      if (got.length !== 0) problems.push(`${row.platform}/${row.arch} ${label}：期望无资产，实际选中 ${got.join(', ')}`)
      return
    }
    if (got.length === 0) {
      problems.push(`${row.platform}/${row.arch} ${label}：一个都没选中，期望 ${want}`)
      return
    }
    if (got.includes(want) !== true) problems.push(`${row.platform}/${row.arch} ${label}：没选中 ${want}，实际 ${got.join(', ')}`)
    if (got.length > 1) problems.push(`${row.platform}/${row.arch} ${label}：选中了多个 ${got.join(', ')}（应唯一）`)
  }

  checkOne('CPA', cpaHit, row.cpa)
  checkOne('插件', pluginHit, row.plugin)
}

/** 单独钉住 `no-plugin` 那条：它绝不能在任何平台上被选中。 */
for (const row of EXPECT) {
  const plat = platformTagOf(row.platform, row.arch)
  const hit = CPA_ASSETS.filter((name) => patternsFor(plat).cpa.test(name)).filter((name) => name.includes('no-plugin'))
  if (hit.length > 0) problems.push(`${row.platform}/${row.arch} 选中了 no-plugin 包：${hit.join(', ')}`)
}

if (problems.length > 0) {
  process.stderr.write('平台资产匹配失败：\n')
  for (const item of problems) process.stderr.write(`  ✗ ${item}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`平台资产匹配正常（${String(EXPECT.length)} 个平台组合，zip 与 tar.gz 都认，no-plugin 已排除）\n`)
}

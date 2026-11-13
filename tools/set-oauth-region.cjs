// 改 CPA 的登录区域：cn = 国内（copilot.tencent.com），intl = 国际（codebuddy.ai）。
//
// 为什么需要它：官方插件商店那版 workbuddy 默认走**国际区**，登录链接签发成
// codebuddy.ai —— 国内 WorkBuddy / CodeBuddy 账号在那上面登不进去。
// 两边签发的 OAuth state 不通用（在 .ai 上签的拿到 .cn 页面会被拒，HTTP 400），
// 所以必须在**登录之前**定下来。
//
// 用法（在仓库根目录）：node tools/set-oauth-region.cjs cn
// 改完要重启 CPA（npm run cpa 那个窗口，或 systemctl restart buddykey-cpa）。

const fs = require('node:fs')

const region = (process.argv[2] || 'cn').trim()
if (region !== 'cn' && region !== 'intl') {
  console.error('区域只能是 cn（国内）或 intl（国际）')
  process.exit(2)
}

const file = 'runtime/cpa/config.yaml'

let text
try {
  text = fs.readFileSync(file, 'utf8')
} catch {
  console.error(`读不到 ${file} —— 先跑 npm run install-cpa`)
  process.exit(1)
}

/** 已经有这一行就替换；没有就插到 workbuddy: 块的第一行。 */
const existing = /^([ \t]+)oauth_region:[ \t]*\S+[ \t]*$/m

if (existing.test(text) === true) {
  text = text.replace(existing, (_match, indent) => `${indent}oauth_region: ${region}`)
} else {
  /** 4 空格缩进的 `    workbuddy:` —— 这是 install-cpa 生成的那层。 */
  const anchor = /^([ ]{4})workbuddy:[ \t]*$/m
  if (anchor.test(text) !== true) {
    console.error('找不到 plugins.configs.workbuddy 配置块，未改动')
    process.exit(1)
  }
  text = text.replace(anchor, (match, indent) => `${match}\n${indent}  oauth_region: ${region}`)
}

fs.writeFileSync(file, text)

console.log(
  region === 'cn'
    ? '已设为国内区：登录走 copilot.tencent.com'
    : '已设为国际区：登录走 codebuddy.ai',
)
console.log('记得重启 CPA 让配置生效。')

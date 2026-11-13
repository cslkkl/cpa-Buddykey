/**
 * 装一个 git pre-commit 钩子：提交前跑密钥检查。
 *
 * 为什么不靠 `npm run check`：那是**手动**的，忘了跑就漏过去了。
 * 密钥泄露只需要一次疏忽，所以拦在「真要写进 git」的那一刻才有效。
 *
 * 为什么钩子要单独装而不是直接进仓库：`.git/hooks/` 不受版本控制，
 * 别人 clone 下来不会有。所以留一个脚本，加一条 npm 命令让人自己装一次。
 *
 * 用法：`npm run hooks:install`
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const say = (t = '') => process.stdout.write(`${t}\n`)

/** 钩子内容。只用 node，不引任何依赖 —— 这个项目零依赖。 */
const HOOK = `#!/bin/sh
# 由 npm run hooks:install 生成。提交前检查有没有把真实密钥写进 git。
# 要绕过（明确知道自己在做什么）：git commit --no-verify
node tools/check-secrets.mjs --staged || {
  echo ""
  echo "提交被拦下：疑似密钥。确认无误可 git commit --no-verify 绕过。"
  exit 1
}
`

let hooksDir
try {
  /** `--git-path hooks` 会尊重 core.hooksPath，比自己拼 .git/hooks 稳。 */
  hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' }).trim()
} catch {
  process.stderr.write('不在 git 仓库里，装不了钩子。\n')
  process.exitCode = 1
}

if (hooksDir !== undefined) {
  const target = path.resolve(hooksDir, 'pre-commit')

  fs.mkdirSync(path.dirname(target), { recursive: true })

  /** 已有别人的钩子就备份，别静默覆盖。 */
  if (fs.existsSync(target) === true) {
    const existing = fs.readFileSync(target, 'utf8')
    if (existing.includes('check-secrets.mjs') !== true) {
      const backup = `${target}.bak-${String(Date.now())}`
      fs.copyFileSync(target, backup)
      say(`已备份原有钩子到 ${backup}`)
    }
  }

  fs.writeFileSync(target, HOOK, { mode: 0o755 })
  try {
    fs.chmodSync(target, 0o755)
  } catch {
    /** Windows 上 chmod 常常无效但也不影响，git 会自己判断。 */
  }
  say(`钩子已装到 ${target}`)
  say('之后每次 git commit 都会先跑密钥检查；确认无误可用 --no-verify 绕过。')
}

/**
 * 提交前扫描：确认 git 跟踪的文件里没有真实密钥。
 *
 * 为什么要有这个脚本：这个仓库**是公开的**，而它管理的恰好是一堆敏感东西
 * （API key、管理口令、账号登录态）。一次 `git add -f` 就够把密钥写进历史，
 * 写进去之后改历史也来不及 —— 别人可能已经 fork 了。
 * 靠「记得别提交」是靠不住的，落成检查才靠得住。
 *
 * 判据：只扫 **git 跟踪的**文件（`data/` 与 `runtime/` 已被 .gitignore 排除，
 * 但 `-f` 能绕过去，所以这里必须再查一遍「有没有被跟踪的敏感路径」）。
 *
 * 用法：
 *   node tools/check-secrets.mjs           扫已跟踪文件
 *   node tools/check-secrets.mjs --staged   只扫暂存区（pre-commit 用）
 *
 * 退出码：0 = 干净；1 = 发现疑似密钥。
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const STAGED_ONLY = process.argv.includes('--staged')

/** 不许出现在仓库里的路径前缀/文件名（哪怕被 -f 强行加了）。 */
const FORBIDDEN_PATHS = [
  /^data\//,
  /^runtime\//,
  /^bin\//,
  /(^|\/)workbuddy-[0-9a-f-]{8,}\.json$/,
  /(^|\/)\.credentials\.yaml$/,
  /(^|\/)tunnel\.log$/,
  /(^|\/)usage\.jsonl$/,
  /(^|\/)keys\.json$/,
]

/**
 * 密钥形状。
 *
 * 只写**真货的形状**，不写占位符的可能写法 —— 宁可漏报也别把
 * 「文档里写 `sk-pool-你的key`」这种误判成泄露，否则检查会被关掉。
 */
const PATTERNS = [
  /** 本项目的 key：`sk-pool-` + 32 位十六进制。 */
  { name: 'BuddyKey API key', re: /sk-pool-[0-9a-f]{32}/g },
  /** CPA 的本地 key：`sk-cpa-` + 至少 8 位十六进制（示例值 sk-cpa-example 不命中）。 */
  { name: 'CPA access key', re: /sk-cpa-[0-9a-f]{8,}/g },
  /** GitHub token。 */
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  /** 私钥。 */
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  /** 配置里被填成真值的密钥字段（空串与占位不算）。 */
  { name: 'config secret', re: /"(upstreamKey|adminKey|adminPassword)"\s*:\s*"(?!<|你的|xxx)[^"]{8,}"/g },
  /** AWS / 常见云 key。 */
  { name: 'cloud key', re: /\bAKIA[0-9A-Z]{16}\b/g },
]

const say = (t = '') => process.stdout.write(`${t}\n`)

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** 取要检查的文件列表。 */
function filesToCheck() {
  if (STAGED_ONLY) {
    /** `--diff-filter=ACMR` = 新增/复制/修改/重命名；删除的文件没有内容可扫。 */
    const out = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    return out.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  }
  return git(['ls-files']).split('\n').map((l) => l.trim()).filter((l) => l !== '')
}

const problems = []
const files = filesToCheck()

for (const file of files) {
  /* 1. 路径本身不该被跟踪 —— 这条与内容无关，先挡。 */
  for (const rule of FORBIDDEN_PATHS) {
    if (rule.test(file) === true) {
      problems.push({ file, kind: '不该进 git 的路径', sample: file })
      break
    }
  }

  /* 2. 内容扫描。二进制与超大文件跳过（`git ls-files` 里有图片）。 */
  if (/\.(png|jpe?g|ico|gif|webp|exe|dll|so|dylib|zip|gz)$/i.test(file) === true) continue

  let text
  try {
    text = fs.readFileSync(path.resolve(file), 'utf8')
  } catch {
    continue
  }
  /** 纯二进制（含 NUL）跳过。 */
  if (text.includes('\u0000') === true) continue

  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0
    const match = re.exec(text)
    if (match === null) continue
    /** 报告里只留前 12 个字符，别把密钥本身又打印到日志里。 */
    const shown = match[0].length > 12 ? `${match[0].slice(0, 12)}…` : match[0]
    problems.push({ file, kind: name, sample: shown })
  }
}

if (problems.length > 0) {
  process.stderr.write('\n发现疑似密钥，拒绝继续：\n\n')
  for (const item of problems) {
    process.stderr.write(`  ✗ ${item.file}\n`)
    process.stderr.write(`      ${item.kind}：${item.sample}\n`)
  }
  process.stderr.write('\n')
  process.stderr.write('这些是真实凭据，进了 git 历史就撤不回来（别人可能已经 fork）。\n')
  process.stderr.write('处理办法：\n')
  process.stderr.write('  - 误加进来的文件：git rm --cached <文件>，并确认 .gitignore 覆盖到\n')
  process.stderr.write('  - 文档里的示例：换成明显的占位写法（sk-pool-你的key / <你的口令>）\n')
  process.stderr.write('  - 真提交过：立刻作废那个密钥（重建），光删文件没用\n')
  process.stderr.write('\n')
  process.exitCode = 1
} else {
  say(`密钥检查通过（${String(files.length)} 个已跟踪文件，无真实凭据）`)
}

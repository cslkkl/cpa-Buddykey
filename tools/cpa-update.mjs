#!/usr/bin/env node
/**
 * `npm run check:updates` —— 命令行查 / 更新上游版本。
 *
 * 页面上有同样的能力（`/admin/api/updates`），这个脚本是给两种场合用的：
 *   - 远程帮别人看「你那份旧不旧」，不用开浏览器；
 *   - CI / 定时任务里查一眼，只读不写。
 *
 * 用法：
 *   node tools/cpa-update.mjs --check          # 只看，不动磁盘
 *   node tools/cpa-update.mjs --check --key=cpa
 *   node tools/cpa-update.mjs --apply          # 真更新（CPA 必须停着）
 *
 * ⚠️ `--apply` 前必须先停 CPA：Windows 上被加载的 dll 改不了名。
 *   本脚本不替你停 —— 它没有 CPA 的进程句柄，也不去猜。
 */

import process from 'node:process'
import { updateView, updateResultLine, resolveSourceKey, SOURCE_KEYS } from '../lib/update-text.mjs'
import { checkUpdate, installSource } from './upstream.mjs'

const say = (text = '') => process.stdout.write(`${text}\n`)

function parseArgs(argv) {
  const flags = {}
  for (const token of argv) {
    if (token.startsWith('--') !== true) continue
    const eq = token.indexOf('=')
    if (eq > 2) flags[token.slice(2, eq)] = token.slice(eq + 1)
    else flags[token.slice(2)] = 'true'
  }
  return flags
}

const flags = parseArgs(process.argv.slice(2))
const key = resolveSourceKey(typeof flags.key === 'string' ? flags.key : '')

if (key === undefined) {
  process.stderr.write(`不认识的来源。可选：${SOURCE_KEYS.join(' / ')}\n`)
  process.exit(2)
}

const apply = flags.apply === 'true'

const info = await checkUpdate(key)
const view = updateView(info)

say('')
say('BuddyKey · 上游版本')
say('──────────────────────────────────────────────')
say(`来源　　${key}`)
if (info.ok === true) {
  say(`已装　　${info.installed === null ? '未知（本版未记录）' : info.installed.tag}`)
  say(`上游　　${info.latest.tag}　${info.latest.name}（${(info.latest.size / 1048576).toFixed(1)} MB）`)
  say(`磁盘　　${info.installedPresent === true ? '有' : '没有'}`)
}
say(`判定　　${view.line === '' ? '（认不出上游响应）' : view.line}`)
say('')

if (info.ok !== true && apply !== true) {
  process.stderr.write(`查询失败：${String(info.error)}\n`)
  process.exit(1)
}

if (apply !== true) {
  say(view.action === 'update' ? '要更新就跑：node tools/cpa-update.mjs --apply（先把 CPA 停掉）' : '无需动作。')
  process.exit(info.ok === true ? 0 : 1)
}

say('开始更新（请确认 CPA 已经停掉）…')
const outcome = await installSource(key, { force: true })
say('')
say(updateResultLine(outcome))
if (outcome.ok === true) {
  say('')
  say('⚠️ 插件换个版本时模型前缀可能会变（wb/ ↔ cn/）。')
  say('   重启 BuddyKey 会自动重探模型名；页面上的 /healthz 会报 modelSource。')
  say('')
  process.exit(0)
}
process.stderr.write(`\n失败于阶段 ${String(outcome.phase)}\n`)
process.exit(1)

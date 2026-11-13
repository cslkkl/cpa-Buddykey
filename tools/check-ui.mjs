/**
 * 守 `lib/ui.mjs` 的模板字符串纪律。
 *
 * 为什么需要这个检查：那个文件整个页面是一个模板字面量，**注释里多写一个反引号
 * 就会提前结束它**。而 `node --check` 抓不住这种情况 —— 如果那个反引号恰好有
 * 配对的第二个，语法依然成立，页面却被截断成半截，浏览器里看起来就是
 * 「样式没了 / 按钮不响应」，排查方向会全跑偏（实测踩过）。
 *
 * 所以不数反引号（JSDoc 里本来就有一堆，数总数不可靠），而是直接断言
 * **真正在意的不变量**：PAGE 是不是从 doctype 开始、到 </html> 结束、
 * 三个占位符各出现一次。
 *
 * 用法：`node tools/check-ui.mjs`（已挂进 `npm run check`）。
 */

import { PAGE } from '../lib/ui.mjs'

const problems = []

if (PAGE.startsWith('<!doctype html') !== true) {
  problems.push(`PAGE 没有从 <!doctype html 开始 —— 模板开头附近有反引号提前结束了它。\n  实际开头：${JSON.stringify(PAGE.slice(0, 60))}`)
}

if (PAGE.trimEnd().endsWith('</body></html>') !== true) {
  problems.push(`PAGE 没有以 </body></html> 结束 —— 模板尾部被截断了。\n  实际结尾：${JSON.stringify(PAGE.slice(-60))}`)
}

/** 占位符必须各出现一次：少了页面缺内容，多了说明有重复注入点。 */
const placeholders = ['__LAN_HINT__', '__MODELS__', '__UPDATE_TEXT__']
for (const name of placeholders) {
  const count = PAGE.split(name).length - 1
  if (count !== 1) {
    problems.push(`占位符 ${name} 在 PAGE 里出现 ${String(count)} 次，应为 1 次`)
  }
}

/** 结构锚点：分段控件/卡片存在，说明 HTML 没被腰斩到一半。 */
const anchors = ['id="health"', 'id="updateRow"', 'id="viewKeys"', 'id="overlay"', 'refreshAll()']
for (const anchor of anchors) {
  if (PAGE.includes(anchor) !== true) problems.push(`PAGE 里找不到结构锚点 ${anchor}`)
}

if (problems.length > 0) {
  process.stderr.write('lib/ui.mjs 结构检查失败：\n')
  for (const item of problems) process.stderr.write(`  ✗ ${item}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`lib/ui.mjs 结构正常（${String(PAGE.length)} 字节，3 个占位符各 1 次）\n`)
}

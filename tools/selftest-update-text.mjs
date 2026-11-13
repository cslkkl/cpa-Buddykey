import { updateView, updateResultLine, resolveSourceKey } from '../lib/update-text.mjs'

const cases = [
  ['认得且一致', { ok: true, installed: { tag: 'v0.10.0' }, latest: { tag: 'v0.10.0' }, hasUpdate: false }],
  ['认得且不同', { ok: true, installed: { tag: 'v0.9.9' }, latest: { tag: 'v0.10.0' }, hasUpdate: true }],
  ['没记录', { ok: true, installed: null, latest: { tag: 'v0.10.0' } }],
  ['查询失败', { ok: false, error: 'ECONNRESET' }],
  ['认不出', { ok: true }],
  ['undefined', undefined],
]

for (const [name, info] of cases) {
  console.log(name.padEnd(14), '->', JSON.stringify(updateView(info)))
}

console.log('')
console.log('resolveSourceKey("")     ->', resolveSourceKey(''))
console.log('resolveSourceKey("cpa")  ->', resolveSourceKey('cpa'))
console.log('resolveSourceKey("nope") ->', resolveSourceKey('nope'))
console.log('')
console.log('result(stopped) ->', updateResultLine({ ok: true, tag: 'v0.10.0', stopped: true }))
console.log('result(ok)      ->', updateResultLine({ ok: true, tag: 'v0.10.0' }))
console.log('result(fail)    ->', updateResultLine({ ok: false, error: 'sha256 不匹配' }))

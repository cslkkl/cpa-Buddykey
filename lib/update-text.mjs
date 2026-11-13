/**
 * 「上游有没有新版」这件事的**纯判据**。
 *
 * 与 [../tools/upstream.mjs] 分开是有意的，沿用 dsh-cpa-switch 的分层理由：
 * 那边把 `updateView` 单独放一个文件，是因为「含 JSX 的文件 Node 侧判据 import 不了，
 * 于是这段分支不少的判定会一条判据都没有」。这里同理 —— 本文件不碰网络、不碰磁盘，
 * 只吃一个响应对象、吐一行话和一个动作，所以能被直接测。
 *
 * ## 三条不许含糊的口径（照抄参考实现的结论，理由在它那边验证过）
 *
 * 1. **「没记录」不等于「有新版」**：老机器升级上来时没记过装的是哪一版，
 *    那时只能说「未知」。说「有新版」会催用户去换一份可能已经最新的东西；
 *    说「已是最新」则把真话说反。
 * 2. **查不到上游 ≠ 已是最新**：断网 / 限流时如实说「查不到」，不说「已是最新」。
 * 3. **认不出的响应什么都不说**：返回空行让调用方不渲染，而不是印一句「已是最新」——
 *    那是替后端撒谎。
 *
 * ## 为什么判据是「tag 相等」而不是解析版本号
 *
 * 参考实现把这条当决策写下来了：解析 semver 只是为了文案能说「新版」，
 * 却要写一套解析 + 一个纯判据文件 + 前导 `v` / 后缀那堆边界。
 * 改成**两个 tag 都显示、谁新谁旧由人看**，同一个目的，零解析。
 *
 * ⚠️ 已知边界：上游若**重打包同一个 tag**，这里会说「已是最新」而内容其实换了。
 *   不假装它比 tag 更准 —— 这条也照抄。
 *
 * @module buddykey/update-text
 */

/**
 * 上游来源。`key` 即安装记录里的键名。
 *
 * 只有 `plugins` 暴露在页面上：CPA 本体的替换风险高得多（它是唯一能起服务的那个），
 * 与参考实现同一取舍 —— 机制按 key 通用，以后要把本体纳进来不用改路径。
 */
export const SOURCE_KEYS = ['cpa', 'plugins']

/** 页面上默认查哪个来源。 */
export const DEFAULT_SOURCE = 'plugins'

/** 每个来源给用户看的名字。 */
export const SOURCE_LABELS = {
  cpa: 'CPA 本体',
  plugins: 'workbuddy 渠道插件',
}

/** 把任意字符串收窄成已知来源；不认识时 `undefined`。 */
export function asSourceKey(value) {
  return SOURCE_KEYS.includes(value) ? value : undefined
}

/** 解析来源参数：空串取默认值，其余必须已知。 */
export function resolveSourceKey(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed === '' ? DEFAULT_SOURCE : asSourceKey(trimmed)
}

/**
 * 一行话 + 一个该给的动作。
 *
 * @param {object|undefined} info `GET /admin/api/updates` 的返回
 *   形如 `{ ok, key, installed: {tag,at}|null, latest: {tag,name,size}, hasUpdate?, error? }`
 * @returns {{ line: string, action: 'update'|'retry'|'none', tone: 'ok'|'warn'|'idle' }}
 *   `tone` 决定页面圆点颜色：`ok` 绿、`warn` 需要动作、`idle` 中性。
 */
export function updateView(info) {
  if (info === undefined || info === null || typeof info !== 'object') {
    return { line: '', action: 'none', tone: 'idle' }
  }

  if (info.ok === false) {
    return {
      line: `查不到上游版本：${typeof info.error === 'string' ? info.error : '未知原因'}`,
      action: 'retry',
      tone: 'warn',
    }
  }

  const latestTag = info.latest !== null && typeof info.latest === 'object' ? info.latest.tag : undefined
  if (typeof latestTag !== 'string' || latestTag === '') {
    /** 认不出响应：不渲染，不编。 */
    return { line: '', action: 'none', tone: 'idle' }
  }

  const installedTag =
    info.installed !== null && typeof info.installed === 'object' && typeof info.installed.tag === 'string'
      ? info.installed.tag
      : undefined

  if (installedTag === undefined) {
    return {
      line: `已装版本未知（本版未记录）· 上游当前 ${latestTag}`,
      action: 'update',
      tone: 'warn',
    }
  }
  if (info.hasUpdate !== true) {
    return { line: `已是 ${installedTag}，与上游一致`, action: 'none', tone: 'ok' }
  }
  return { line: `${installedTag} → ${latestTag}`, action: 'update', tone: 'warn' }
}

/**
 * 更新跑完之后那一行话。
 *
 * ⚠️ **「CPA 已停止」必须说出来**：Windows 上被加载的 dll 改不了名，所以换文件之前
 *   必须先停 CPA。不说的话用户看到「更新成功」却怎么也连不上，只能自己猜是谁把服务关了。
 *   —— 参考实现把这条写在 `updateResultLine` 的注释里，理由是同一个。
 */
export function updateResultLine(outcome) {
  if (outcome === null || outcome === undefined || typeof outcome !== 'object') return ''
  if (outcome.ok !== true) {
    const reason = typeof outcome.error === 'string' && outcome.error !== '' ? `：${outcome.error}` : ''
    return `更新失败${reason}`
  }
  const tag = typeof outcome.tag === 'string' && outcome.tag !== '' ? outcome.tag : ''
  const head = tag === '' ? '已更新' : `已更新到 ${tag}`
  if (outcome.stopped === true) return `${head}。CPA 已停止，需要时手动重新启动（npm run cpa）`
  return `${head}。`
}

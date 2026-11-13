/**
 * 零依赖 tar.gz 解包。
 *
 * 为什么需要它：CPA 的发布包**按平台用了不同容器** ——
 *   Windows → `.zip`
 *   Linux / macOS → `.tar.gz`
 * 原先只支持 zip，于是在 Linux 服务器上 `install-cpa` 会停在
 * 「release 里没有匹配 _linux_amd64.zip 的资产」—— 装都装不起来。
 *
 * 只实现需要的子集：ustar 格式、普通文件（typeflag '0' 或 '\0'）。
 * 额外处理 GNU 长文件名（typeflag 'L'），因为 tar 打包时文件名超过 100 字节会走它。
 * 不处理符号链接/设备节点 —— 这两个包都不含。
 *
 * 参考：POSIX ustar 头布局（512 字节定长）。
 */

import zlib from 'node:zlib'
import { extractZip } from './zip.mjs'

const BLOCK = 512

/** tar 里的数字是**八进制文本**，末尾可能有 NUL 或空格，也可能用 base-256（首字节 0x80）。 */
function readNumber(block, offset, length) {
  const slice = block.subarray(offset, offset + length)
  if (slice[0] === 0x80) {
    /** GNU base-256：大端整数，剩下的是二进制。 */
    let value = 0
    for (let i = 1; i < slice.length; i += 1) value = value * 256 + slice[i]
    return value
  }
  const text = slice.toString('latin1').replace(/\0.*$/, '').trim()
  if (text === '') return 0
  const parsed = Number.parseInt(text, 8)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 名字字段以 NUL 结束。 */
function readString(block, offset, length) {
  const slice = block.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return (end < 0 ? slice : slice.subarray(0, end)).toString('utf8')
}

/** 一个头块是不是全零（tar 用连续两个零块表示结束）。 */
function isZeroBlock(block) {
  for (let i = 0; i < block.length; i += 1) if (block[i] !== 0) return false
  return true
}

/**
 * 列出 tar 条目。
 *
 * 返回 `[{ name, size, type, dataStart }]`；`dataStart` 是数据在 buffer 里的起点。
 */
export function listTar(buffer) {
  const entries = []
  let offset = 0
  /** GNU 长名：前一个 'L' 条目的数据就是下一个条目的真名。 */
  let pendingName = ''

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK)
    if (isZeroBlock(header) === true) break

    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const size = readNumber(header, 124, 12)
    const type = String.fromCharCode(header[156] === 0 ? 0x30 : header[156])
    const dataStart = offset + BLOCK

    /** 数据按 512 向上取整。 */
    const blocks = Math.ceil(size / BLOCK)
    const nextOffset = dataStart + blocks * BLOCK

    if (type === 'L') {
      pendingName = buffer.subarray(dataStart, dataStart + size).toString('utf8').replace(/\0.*$/, '')
      offset = nextOffset
      continue
    }

    const fullName = pendingName !== '' ? pendingName : prefix !== '' ? `${prefix}/${name}` : name
    pendingName = ''

    entries.push({ name: fullName, size, type, dataStart })
    offset = nextOffset
  }

  return entries
}

/**
 * 解 `.tar.gz` 成「名字 → Buffer」的 Map，跳过目录与非普通文件。
 *
 * 与 `extractZip` 同形，好让上层按扩展名派发，不必关心是哪种容器。
 */
export function extractTarGz(buffer) {
  const tar = zlib.gunzipSync(buffer)
  const out = new Map()

  for (const entry of listTar(tar)) {
    /** '5' = 目录；'x'/'g' = pax 扩展头（跳过，文件名我们已从基本头拿到）。 */
    if (entry.type === '5' || entry.type === 'x' || entry.type === 'g') continue
    /** '0' 普通文件、'\0'（已被上面归一成 '0'）、'7' 连续文件，其余（链接/设备）都不要。 */
    if (entry.type !== '0' && entry.type !== '7') continue
    /** 去掉开头的 ./ —— 上游打包时常带。 */
    const name = entry.name.replace(/^\.\//, '')
    if (name === '' || name.endsWith('/')) continue
    out.set(name, Buffer.from(tar.subarray(entry.dataStart, entry.dataStart + entry.size)))
  }

  return out
}

/**
 * 按容器类型解包，返回「名字 → Buffer」的 Map。
 *
 * 上层（`tools/upstream.mjs`）只调这个 —— 平台与容器的差异收在这一层，
 * 免得流程里散落「if windows … else …」。
 *
 * ⚠️ 必须同时认 zip 与 tar.gz：上游 Windows 发 zip、Linux/macOS 发 tar.gz，
 *   少认一种就是「在某个平台上装不起来」。
 */
export function extractArchive(buffer, fileName) {
  if (/\.tar\.gz$/i.test(fileName) === true || /\.tgz$/i.test(fileName) === true) {
    return extractTarGz(buffer)
  }
  if (/\.zip$/i.test(fileName) === true) return extractZip(buffer)
  throw new Error(`不认识的包格式：${fileName}（只支持 .zip / .tar.gz）`)
}

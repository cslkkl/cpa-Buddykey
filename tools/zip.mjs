/**
 * 零依赖 zip 提取。
 *
 * 为什么自己写：项目不引 npm 包，而 Node 没有内置解压。
 * 系统上有 `tar -xf`（Windows 10+ 自带 bsdtar）或 PowerShell 的 Expand-Archive，
 * 但它们的存在与行为依平台而定 —— 这里要的是「在任何一台装了 Node 的机器上都能解」。
 *
 * 只实现需要的那个子集：central directory + stored/deflate 两种 method。
 * 不支持 zip64（本项目要解的两个包分别 3.3 MB 与 26 MB，远不到 4 GB 上限）。
 *
 * 参考：PKWARE APPNOTE.TXT 的 4.3.12（central directory）与 4.3.7（local header）。
 */

import zlib from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

/** EOCD 之后最多只有 65535 字节注释，所以从尾部 64 KB 里找就够了。 */
const EOCD_SEARCH_BYTES = 0xffff + 22

function findEocd(buffer) {
  const start = Math.max(0, buffer.length - EOCD_SEARCH_BYTES)
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/**
 * 列出 zip 里的条目（不读内容）。
 *
 * 返回 `[{ name, method, compressedSize, uncompressedSize, localOffset }]`。
 */
export function listZip(buffer) {
  if (Buffer.isBuffer(buffer) !== true) throw new TypeError('listZip 需要 Buffer')
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new Error('不是合法的 zip：找不到 EOCD')

  const total = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = []

  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(offset) !== CEN_SIG) {
      throw new Error(`zip 结构异常：第 ${String(index)} 个中央目录条目的签名不对`)
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    /** bit 11 = 文件名是 UTF-8。中文名要走这个分支，否则按 UTF-8 解也可能对，先用 utf8。 */
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

/** 取单个条目的原始字节（已解压）。 */
export function readZipEntry(buffer, entry) {
  const loc = entry.localOffset
  if (buffer.readUInt32LE(loc) !== LOC_SIG) {
    throw new Error(`zip 结构异常：${entry.name} 的本地头签名不对`)
  }
  /**
   * ⚠️ 必须用**本地头**里的 name/extra 长度算数据起点。
   * 中央目录里的 extra 常与本地头不同（尤其带 unicode path 扩展时），
   * 拿中央目录的长度去算会整体偏移，解出来的字节是坏的且不会报错。
   */
  const nameLength = buffer.readUInt16LE(loc + 26)
  const extraLength = buffer.readUInt16LE(loc + 28)
  const dataStart = loc + 30 + nameLength + extraLength
  const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize)

  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) return zlib.inflateRawSync(raw)
  throw new Error(`不支持的 zip 压缩方法 ${String(entry.method)}（${entry.name}）`)
}

/**
 * 把 zip 解到一个「名字 → Buffer」的 Map 里，跳过目录项。
 *
 * 不直接写盘：调用方要自己决定落到哪、要不要先校验 —— 下载来的二进制
 * 先全量解在内存里再落盘，比边解边写更容易在失败时保持目标目录干净。
 */
export function extractZip(buffer) {
  const out = new Map()
  for (const entry of listZip(buffer)) {
    if (entry.name.endsWith('/')) continue
    out.set(entry.name, readZipEntry(buffer, entry))
  }
  return out
}

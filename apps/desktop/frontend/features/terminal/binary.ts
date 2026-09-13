/** base64 / UTF-8 转换（浏览器环境，无 Node Buffer）。 */

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 分块转 binary string，规避 String.fromCharCode 参数上限（1 MiB 粘贴场景）。 */
export function encodeBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** UTF-8 字节数（不实际编码：粘贴尺寸守卫在热路径上，避免 1 MiB 拷贝）。 */
export function utf8Length(text: string): number {
  let size = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) size += 1
    else if (code < 0x800) size += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      size += 4
      i += 1 // 代理对
    } else size += 3
  }
  return size
}

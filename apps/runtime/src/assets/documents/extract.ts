import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import {
  DocumentExtractionSchema,
  MAX_DOCUMENT_CHARS,
  TEXT_FILE_EXTENSIONS,
  type DocumentExtraction,
} from '@reflexion-os-studio/contracts'
import { CommandError } from '../../agent/errors.js'

let activeWorkers = 0

export async function extractDocument(
  fileName: string,
  bytes: Buffer,
): Promise<DocumentExtraction> {
  const extension = fileName.split('.').at(-1)!.toLowerCase()
  if (TEXT_FILE_EXTENSIONS.some((item) => item === extension)) {
    if (bytes.length > MAX_DOCUMENT_CHARS * 4)
      throw new CommandError('invalid_request', '文本过长，请拆分文件')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new CommandError('invalid_request', '文本文件必须使用 UTF-8 编码')
    }
    if (!text.trim() || /[\x00-\x08\x0b\x0e-\x1f]/.test(text))
      throw new CommandError('invalid_request', '文件为空或包含二进制内容')
    if (text.length > MAX_DOCUMENT_CHARS)
      throw new CommandError(
        'invalid_request',
        '提取文字超过 60000 字符，请拆分文件',
      )
    const numbered = text
      .split(/\r?\n/)
      .map((line, index) => `${index + 1}: ${line}`)
      .join('\n')
    if (numbered.length > MAX_DOCUMENT_CHARS)
      throw new CommandError(
        'invalid_request',
        '提取文字超过 60000 字符，请拆分文件',
      )
    return { text: numbered, format: 'text' }
  }
  if (extension !== 'pdf' && extension !== 'docx')
    throw new CommandError(
      'invalid_request',
      '仅支持图片、文本/代码、PDF 与 DOCX；不支持 DOC',
    )
  if (activeWorkers >= 2)
    throw new CommandError('invalid_request', '文档解析繁忙，请稍后重试')
  const bundled = new URL('./document-worker.mjs', import.meta.url)
  const url = existsSync(bundled)
    ? bundled
    : new URL('./worker.js', import.meta.url)
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, {
      workerData: { bytes: new Uint8Array(bytes), format: extension },
      resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
      execArgv: [],
    })
    activeWorkers++
    let settled = false
    // Drain and discard parser diagnostics; they may contain document contents.
    worker.stdout?.resume()
    worker.stderr?.resume()
    const finish = (error?: string, result?: unknown) => {
      if (settled) return
      settled = true
      activeWorkers--
      clearTimeout(timer)
      void worker.terminate()
      if (error) reject(new CommandError('invalid_request', error))
      else {
        const parsed = DocumentExtractionSchema.safeParse(result)
        if (parsed.success) resolve(parsed.data)
        else reject(new CommandError('invalid_request', '文档提取结果无效'))
      }
    }
    const timer = setTimeout(
      () => finish('文档解析超过 15 秒，请拆分或转换为文本'),
      15_000,
    )
    worker.once('message', (message) => finish(message.error, message.result))
    worker.once('error', () => finish('文档解析失败，请拆分或转换为文本'))
    worker.once('exit', () => finish('文档解析线程已停止'))
  })
}

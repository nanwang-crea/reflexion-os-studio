import { parentPort, workerData } from 'node:worker_threads'
import { unzipSync } from 'fflate'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { getDocumentProxy } from 'unpdf'
import { MAX_DOCUMENT_CHARS } from '@reflexion-os-studio/contracts'

// PDF.js must never log into the Runtime's JSON-RPC stdout.
console.log = console.warn = console.info = () => {}
class DocumentError extends Error {}

const MAX_PAGES = 200
const MAX_XML_BYTES = 8 * 1024 * 1024

async function pdfText(bytes: Uint8Array) {
  if (Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-')
    throw new DocumentError('PDF 内容与扩展名不符')
  const pdf = await getDocumentProxy(bytes, {
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  })
  try {
    if (pdf.numPages > MAX_PAGES) throw new DocumentError('PDF 最多支持 200 页')
    const pages: string[] = []
    let length = 0
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ')
      }
      if (!text.trim())
        throw new DocumentError(
          `PDF 第 ${index} 页没有可提取文字，扫描页需要 OCR`,
        )
      const section = `【第 ${index} 页】\n${text.trim()}`
      length += section.length + 2
      if (length > MAX_DOCUMENT_CHARS)
        throw new DocumentError('提取文字超过 60000 字符，请拆分文件')
      pages.push(section)
      page.cleanup()
    }
    return { text: pages.join('\n\n'), format: 'pdf', pages: pdf.numPages }
  } finally {
    await pdf.loadingTask.destroy()
  }
}

type XmlNode = Record<string, unknown>
function xmlText(nodes: XmlNode[]): string {
  let text = ''
  for (const node of nodes) {
    for (const [tag, value] of Object.entries(node)) {
      if (tag === '#text') text += String(value)
      else if (tag === 'w:tab') text += '\t'
      else if (tag === 'w:br') text += '\n'
      else if (Array.isArray(value)) {
        text += xmlText(value)
        if (tag === 'w:p' || tag === 'w:tr') text += '\n'
        if (tag === 'w:tc') text += '\t'
      }
    }
  }
  return text
}

function docxText(bytes: Uint8Array) {
  let total = 0
  let entries = 0
  const zip = unzipSync(bytes, {
    filter(entry) {
      entries++
      total += entry.originalSize
      if (
        entries > 2000 ||
        total > 32 * 1024 * 1024 ||
        entry.originalSize > MAX_XML_BYTES
      )
        throw new DocumentError('DOCX 解压大小或条目数超限')
      if (entry.name.toLowerCase().includes('vbaproject'))
        throw new DocumentError('不支持含宏的文档')
      return entry.name === 'word/document.xml'
    },
  })
  const raw = zip['word/document.xml']
  if (!raw || raw.length > MAX_XML_BYTES)
    throw new DocumentError('DOCX 文件无效')
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new DocumentError('DOCX XML 格式无效')
  const nodes = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false,
  }).parse(xml) as XmlNode[]
  const text = xmlText(nodes).trim()
  if (!text) throw new DocumentError('DOCX 没有可提取文字，不支持图片扫描件')
  if (text.length > MAX_DOCUMENT_CHARS)
    throw new DocumentError('提取文字超过 60000 字符，请拆分文件')
  return { text, format: 'docx' }
}

try {
  const { bytes, format } = workerData as { bytes: Uint8Array; format: string }
  const result = format === 'pdf' ? await pdfText(bytes) : docxText(bytes)
  parentPort!.postMessage({ result })
} catch (error) {
  parentPort!.postMessage({
    error:
      error instanceof DocumentError
        ? error.message
        : '文件损坏、加密或无法解析，请转换为 UTF-8 文本后重试',
  })
}

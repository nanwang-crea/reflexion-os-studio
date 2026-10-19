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
const MAX_SHEETS = 20
const MAX_ROWS = 5000
const MAX_COLUMNS = 50
const MAX_ZIP_ENTRIES = 2000
const MAX_UNZIPPED_BYTES = 32 * 1024 * 1024
/** XLSX 里需要读取的部件：工作簿目录、关系表、共享字符串与各工作表。 */
const XLSX_PARTS = new Set([
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/sharedstrings.xml',
])
const XLSX_SHEET_RE = /^xl\/worksheets\/[^/]+\.xml$/i

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/** 收集节点下的全部文本：兼容 <t> 与富文本 <r><t> 两种形态。 */
function collectText(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join('')
  if (node && typeof node === 'object')
    return Object.entries(node as Record<string, unknown>)
      .filter(([tag]) => !tag.startsWith('@_'))
      .map(([, value]) => collectText(value))
      .join('')
  return ''
}

/** "B12" → 1（0 起始列号），用于按列补齐制表符。 */
function columnIndex(reference: unknown): number {
  const letters = /^([A-Za-z]+)/.exec(String(reference ?? ''))?.[1]
  if (!letters) return -1
  let index = 0
  for (const letter of letters.toUpperCase())
    index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

function parseXml(raw: Uint8Array, label: string): Record<string, unknown> {
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new DocumentError(`${label} XML 格式无效`)
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: false,
  }).parse(xml) as Record<string, unknown>
}

function xlsxText(bytes: Uint8Array) {
  if (Buffer.from(bytes.subarray(0, 4)).toString('latin1') !== 'PK\u0003\u0004')
    throw new DocumentError('XLSX 内容与扩展名不符')
  let entries = 0
  let total = 0
  const zip = unzipSync(bytes, {
    filter(entry) {
      entries++
      total += entry.originalSize
      if (
        entries > MAX_ZIP_ENTRIES ||
        total > MAX_UNZIPPED_BYTES ||
        entry.originalSize > MAX_XML_BYTES
      )
        throw new DocumentError('XLSX 解压大小或条目数超限')
      const name = entry.name.toLowerCase()
      if (name.includes('vbaproject'))
        throw new DocumentError('不支持含宏的表格')
      return XLSX_PARTS.has(name) || XLSX_SHEET_RE.test(entry.name)
    },
  })
  // fflate 的键按原始大小写；建立小写索引避免大小写差异导致取不到部件。
  const parts = new Map<string, Uint8Array>()
  const sheets = new Map<string, Uint8Array>()
  for (const [name, data] of Object.entries(zip)) {
    const lower = name.toLowerCase()
    if (XLSX_SHEET_RE.test(name)) sheets.set(lower, data)
    else parts.set(lower, data)
  }
  const workbookRaw = parts.get('xl/workbook.xml')
  if (!workbookRaw) throw new DocumentError('XLSX 文件无效：缺少 workbook.xml')

  const sharedRaw = parts.get('xl/sharedstrings.xml')
  const shared = sharedRaw
    ? asArray(
        (parseXml(sharedRaw, 'XLSX').sst as Record<string, unknown> | undefined)
          ?.si,
      ).map((node) => collectText(node))
    : []

  const workbook = parseXml(workbookRaw, 'XLSX') as {
    workbook?: { sheets?: { sheet?: unknown } }
  }
  const sheetEntries = asArray(workbook.workbook?.sheets?.sheet) as Array<
    Record<string, unknown>
  >
  if (sheetEntries.length === 0) throw new DocumentError('XLSX 没有工作表')
  if (sheetEntries.length > MAX_SHEETS)
    throw new DocumentError(`XLSX 最多支持 ${MAX_SHEETS} 个工作表`)

  // r:id → 工作表部件路径，走 workbook.xml.rels，不靠文件名顺序猜。
  const relsRaw = parts.get('xl/_rels/workbook.xml.rels')
  const targets = new Map<string, string>()
  if (relsRaw) {
    const rels = parseXml(relsRaw, 'XLSX') as {
      Relationships?: { Relationship?: unknown }
    }
    for (const rel of asArray(rels.Relationships?.Relationship) as Array<
      Record<string, unknown>
    >) {
      const id = String(rel['@_Id'] ?? '')
      const target = String(rel['@_Target'] ?? '')
      if (id && target)
        targets.set(
          id,
          target.startsWith('/')
            ? target.slice(1).toLowerCase()
            : `xl/${target}`.toLowerCase(),
        )
    }
  }

  const sections: string[] = []
  let length = 0
  let rows = 0
  for (const [index, sheet] of sheetEntries.entries()) {
    const name = String(sheet['@_name'] ?? `Sheet${index + 1}`)
    const relId = String(sheet['@_r:id'] ?? '')
    const data =
      (relId ? sheets.get(targets.get(relId) ?? '') : undefined) ??
      sheets.get(`xl/worksheets/sheet${index + 1}.xml`)
    if (!data) continue
    const parsed = parseXml(data, 'XLSX') as {
      worksheet?: { sheetData?: { row?: unknown } }
    }
    const lines: string[] = [`【工作表 ${name}】`]
    for (const row of asArray(parsed.worksheet?.sheetData?.row)) {
      if (++rows > MAX_ROWS)
        throw new DocumentError(`XLSX 最多支持 ${MAX_ROWS} 行，请拆分文件`)
      const cells = new Map<number, string>()
      for (const cell of asArray((row as Record<string, unknown>).c) as Array<
        Record<string, unknown>
      >) {
        const column = columnIndex(cell['@_r'])
        if (column < 0 || column >= MAX_COLUMNS) continue
        const type = String(cell['@_t'] ?? '')
        let value = ''
        if (type === 's') {
          const sharedIndex = Number(cell.v)
          value = Number.isInteger(sharedIndex)
            ? (shared[sharedIndex] ?? '')
            : ''
        } else if (type === 'inlineStr') value = collectText(cell.is)
        else if (type === 'b') value = String(cell.v) === '1' ? 'TRUE' : 'FALSE'
        else if (type === 'e') value = ''
        else value = cell.v === undefined ? '' : String(cell.v)
        if (value.trim()) cells.set(column, value.replace(/\s+/g, ' ').trim())
      }
      if (cells.size === 0) continue
      const last = Math.max(...cells.keys())
      const row_ = Array.from(
        { length: last + 1 },
        (_, i) => cells.get(i) ?? '',
      )
      lines.push(row_.join('\t').trimEnd())
    }
    if (lines.length === 1) continue
    const section = lines.join('\n')
    length += section.length + 2
    if (length > MAX_DOCUMENT_CHARS)
      throw new DocumentError('提取文字超过 60000 字符，请拆分文件')
    sections.push(section)
  }
  if (sections.length === 0)
    throw new DocumentError('XLSX 没有可提取文字，请确认单元格内有内容')
  return { text: sections.join('\n\n'), format: 'xlsx', pages: sections.length }
}

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
        entries > MAX_ZIP_ENTRIES ||
        total > MAX_UNZIPPED_BYTES ||
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
  const result =
    format === 'pdf'
      ? await pdfText(bytes)
      : format === 'xlsx'
        ? xlsxText(bytes)
        : docxText(bytes)
  parentPort!.postMessage({ result })
} catch (error) {
  parentPort!.postMessage({
    error:
      error instanceof DocumentError
        ? error.message
        : '文件损坏、加密或无法解析，请转换为 UTF-8 文本后重试',
  })
}

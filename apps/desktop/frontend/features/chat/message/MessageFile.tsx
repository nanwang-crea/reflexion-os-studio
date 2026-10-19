import type { FilePart } from '@reflexion-os-studio/runtime-client'
import './message-files.css'

export function MessageFile({ part }: { part: FilePart }): React.JSX.Element {
  return (
    <details className="message-file">
      <summary title={part.fileName}>
        {part.fileName} · {Math.ceil(part.size / 1024)} KB
        <small>
          已提取 {part.extraction.text.length} 字符
          {part.extraction.pages ? ` · ${part.extraction.pages} 页` : ''} ·
          查看文字
        </small>
      </summary>
      <p>模型将读取以下文字；PDF 图片与文档排版不包含在内。</p>
      <pre>{part.extraction.text}</pre>
    </details>
  )
}

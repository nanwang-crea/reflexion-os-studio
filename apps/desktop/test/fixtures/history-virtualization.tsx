import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { VirtualTranscript } from '../../frontend/features/chat/transcript/VirtualTranscript'
import type { ChatBlock } from '../../frontend/features/chat/chat-blocks'

const block = (index: number): ChatBlock => ({
  kind: 'plain',
  item: {
    toolCalls: [],
    message: {
      id: String(index),
      sessionId: 'fixture',
      runId: null,
      role: index % 2 ? 'assistant' : 'user',
      content: `消息 ${index}`,
      reasoning: '',
      parts: [],
      status: 'completed',
      createdAt: '2026-10-09T00:00:00Z',
      completedAt: null,
    },
  },
})

declare global {
  interface Window {
    historyFixture: {
      prepend: () => void
      append: () => void
      expand: (id: string) => void
      pin: () => void
      baseline: () => void
      virtual: () => void
    }
  }
}

function Fixture() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [blocks, setBlocks] = useState(() =>
    Array.from({ length: 2000 }, (_, i) => block(i)),
  )
  const [pinned, setPinned] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [baseline, setBaseline] = useState(false)
  window.historyFixture = {
    prepend: () =>
      setBlocks((current) => [
        ...Array.from({ length: 100 }, (_, i) => block(i - 100)),
        ...current,
      ]),
    append: () => setBlocks((current) => [...current, block(current.length)]),
    expand: setExpanded,
    pin: () => setPinned(true),
    baseline: () => setBaseline(true),
    virtual: () => setBaseline(false),
  }
  const render = (item: ChatBlock) => {
    if (item.kind !== 'plain') return null
    return (
      <div
        style={{
          height:
            expanded === item.item.message.id
              ? 2200
              : 80 + (Number(item.item.message.id) % 5) * 40,
          background: '#eee',
          overflow: 'hidden',
          whiteSpace: 'pre-wrap',
        }}
      >
        <strong>{item.item.message.content}</strong>
        <p>{'动态高度测试内容 '.repeat(30)}</p>
      </div>
    )
  }
  return (
    <>
      <h1>历史虚拟列表验收</h1>
      <button onClick={() => window.historyFixture.prepend()}>前插历史</button>
      <button onClick={() => window.historyFixture.append()}>追加消息</button>
      <button onClick={() => window.historyFixture.expand('3')}>
        展开长消息
      </button>
      <button onClick={() => setPinned((current) => !current)}>切换贴底</button>
      <div
        ref={scrollRef}
        id="scroll"
        style={{
          height: 600,
          overflow: 'auto',
          overflowAnchor: 'none',
          width: '90vw',
        }}
      >
        {baseline ? (
          blocks.map((item, index) => (
            <div className="transcript-row" data-block-id={index} key={index}>
              {render(item)}
            </div>
          ))
        ) : (
          <VirtualTranscript
            blocks={blocks}
            scrollRef={scrollRef}
            pinned={pinned}
            renderBlock={render}
          />
        )}
      </div>
      <style>
        {
          '.transcript-row{display:flow-root;padding-bottom:22px}.virtual-transcript{overflow-anchor:none}body{font:14px sans-serif}'
        }
      </style>
    </>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)

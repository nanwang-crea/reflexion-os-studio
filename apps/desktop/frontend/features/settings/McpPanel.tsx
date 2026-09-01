import { useCallback, useEffect, useRef, useState } from 'react'
import type { McpServer, McpTool } from '@reflexion-os-studio/runtime-client'
import { addMcp, listMcp, removeMcp, reloadMcp, toggleMcp } from '../../api/mcp'
import type { ConfirmDialogState } from '../../components/ConfirmDialog'
import { TrashIcon } from '../../ui/icons'

const STATUS_LABELS: Record<string, string> = {
  disabled: '已停用',
  ready: '已连接',
  failed: '连接失败',
}

interface McpPanelProps {
  confirm: (state: ConfirmDialogState) => Promise<boolean>
}

/**
 * MCP 服务器管理(设置页分组):添加/移除/启停/手动重连;
 * 连接成功的 server 工具自动进入 Agent 工具集(默认需审批)。
 */
export function McpPanel(props: McpPanelProps): React.JSX.Element {
  const [servers, setServers] = useState<McpServer[]>([])
  const [tools, setTools] = useState<McpTool[]>([])
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 进行中的操作：server id 或特殊键（'add' / 'reload'），避免并发 mutation 交错。
  const pendingRef = useRef<Set<string>>(new Set())
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())

  const withPending = useCallback(
    async <T,>(key: string, task: () => Promise<T>): Promise<T | undefined> => {
      if (pendingRef.current.has(key)) return undefined
      pendingRef.current.add(key)
      setPending(new Set(pendingRef.current))
      try {
        return await task()
      } finally {
        pendingRef.current.delete(key)
        setPending(new Set(pendingRef.current))
      }
    },
    [],
  )

  const isPending = (key: string): boolean => pending.has(key)

  const refresh = async (): Promise<void> => {
    try {
      const result = await listMcp()
      setServers(result.servers)
      setTools(result.tools)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const add = async (): Promise<void> => {
    if (busy) return
    if (name.trim() === '' || command.trim() === '') {
      setError('名称与启动命令为必填项')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await addMcp({
        name: name.trim(),
        command: command.trim(),
        args: args.trim() === '' ? [] : args.trim().split(/\s+/),
        env: [],
      })
      setName('')
      setCommand('')
      setArgs('')
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (server: McpServer): Promise<void> => {
    const confirmed = await props.confirm({
      title: '删除 MCP 服务器？',
      message: `将删除“${server.name}”及其连接配置。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!confirmed) return
    try {
      await withPending(server.id, async () => {
        await removeMcp(server.id)
        await refresh()
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const toggle = async (server: McpServer): Promise<void> => {
    try {
      await withPending(server.id, async () => {
        await toggleMcp(server.id)
        await refresh()
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const reload = async (): Promise<void> => {
    try {
      await withPending('reload', async () => {
        await reloadMcp()
        await refresh()
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  return (
    <div className="mcp-panel">
      <div className="agent-runtime-head">
        <h2>MCP 服务器</h2>
        <p className="hint">
          连接外部 MCP server，其工具自动进入 Agent 工具集并在使用前请求审批。
        </p>
      </div>

      <ul className="mcp-list">
        {servers.map((server) => (
          <li className="mcp-item" key={server.id}>
            <div className="mcp-info">
              <span className="mcp-name">{server.name}</span>
              <code className="mcp-command">
                {server.command} {server.args.join(' ')}
              </code>
              <span
                className={`mcp-status ${
                  server.status === 'failed' ? 'bad' : ''
                }`}
                role={server.status === 'failed' ? 'alert' : 'status'}
              >
                {STATUS_LABELS[server.status] ?? server.status}
                {server.status === 'ready' && ` · ${server.toolCount} 个工具`}
              </span>
              {server.status === 'failed' && server.lastError && (
                <span className="mcp-error">{server.lastError}</span>
              )}
            </div>
            <span className="queue-actions">
              <button
                type="button"
                className="ghost"
                disabled={isPending(server.id) || isPending('reload')}
                onClick={() => void toggle(server)}
              >
                {server.enabled ? '停用' : '启用'}
              </button>
              <button
                type="button"
                className="icon-btn danger"
                title="删除"
                aria-label={`删除 ${server.name}`}
                disabled={isPending(server.id) || isPending('reload')}
                onClick={() => void remove(server)}
              >
                <TrashIcon />
              </button>
            </span>
          </li>
        ))}
        {servers.length === 0 && (
          <li className="mcp-empty">还没有 MCP 服务器</li>
        )}
      </ul>

      <div className="mcp-add">
        <input
          placeholder="名称（例如 数据库）"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          placeholder="启动命令（例如 npx）"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
        />
        <input
          placeholder="参数（空格分隔，例如 -y @server/package）"
          value={args}
          onChange={(event) => setArgs(event.target.value)}
        />
        <button
          type="button"
          className="ghost"
          disabled={busy || isPending('reload')}
          onClick={() => void add()}
        >
          添加并连接
        </button>
      </div>

      {tools.length > 0 && (
        <div className="mcp-tools">
          {tools.slice(0, 8).map((tool) => (
            <code key={`${tool.serverId}/${tool.name}`} className="mcp-tool">
              {tool.serverId}/{tool.name}
            </code>
          ))}
          {tools.length > 8 && (
            <span className="mcp-more">…共 {tools.length} 个</span>
          )}
        </div>
      )}

      <div className="form-actions">
        <button
          type="button"
          className="ghost"
          disabled={isPending('reload') || busy}
          onClick={() => void reload()}
        >
          重新加载全部服务器
        </button>
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  )
}

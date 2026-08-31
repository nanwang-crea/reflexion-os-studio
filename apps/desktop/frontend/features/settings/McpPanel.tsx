import { useEffect, useState } from 'react'
import type { McpServer, McpTool } from '@reflexion-os-studio/runtime-client'
import { addMcp, listMcp, removeMcp, reloadMcp, toggleMcp } from '../../api/mcp'
import { TrashIcon } from '../../ui/icons'

const STATUS_LABELS: Record<string, string> = {
  disabled: '已停用',
  ready: '已连接',
  failed: '连接失败',
}

/**
 * MCP 服务器管理(设置页分组):添加/移除/启停/手动重连;
 * 连接成功的 server 工具自动进入 Agent 工具集(默认需审批)。
 */
export function McpPanel(): React.JSX.Element {
  const [servers, setServers] = useState<McpServer[]>([])
  const [tools, setTools] = useState<McpTool[]>([])
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const remove = async (serverId: string): Promise<void> => {
    try {
      await removeMcp(serverId)
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const toggle = async (serverId: string): Promise<void> => {
    try {
      await toggleMcp(serverId)
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const reload = async (): Promise<void> => {
    try {
      await reloadMcp()
      await refresh()
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
                title={server.lastError ?? ''}
              >
                {STATUS_LABELS[server.status] ?? server.status}
                {server.status === 'ready' && ` · ${server.toolCount} 个工具`}
              </span>
            </div>
            <span className="queue-actions">
              <button className="ghost" onClick={() => void toggle(server.id)}>
                {server.enabled ? '停用' : '启用'}
              </button>
              <button
                className="icon-btn danger"
                title="删除"
                onClick={() => void remove(server.id)}
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
        <button className="ghost" disabled={busy} onClick={() => void add()}>
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
        <button className="ghost" onClick={() => void reload()}>
          重新加载全部服务器
        </button>
        {error && <span className="error">{error}</span>}
      </div>
    </div>
  )
}

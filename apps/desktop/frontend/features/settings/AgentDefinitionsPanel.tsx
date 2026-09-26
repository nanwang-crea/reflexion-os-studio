import { useEffect, useState } from 'react'
import type { AgentDefinition } from '@reflexion-os-studio/runtime-client'
import { listAgents, setAgentEnabled } from '../../api/agents'

/** 可委派 Agent 注册表：只开放启停，官方 prompt/身份仍由 Runtime 管理。 */
export function AgentDefinitionsPanel(): React.JSX.Element {
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    void listAgents()
      .then((items) => {
        if (!disposed) setAgents(items)
      })
      .catch((caught) => {
        if (!disposed)
          setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      disposed = true
    }
  }, [])

  const toggle = async (agent: AgentDefinition): Promise<void> => {
    setBusyId(agent.id)
    setError(null)
    try {
      const result = await setAgentEnabled(agent.id, !agent.enabled)
      setAgents((current) =>
        current.map((item) =>
          item.id === result.agent.id ? result.agent : item,
        ),
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="runtime-group">
      <h4 className="runtime-group-title">可委派 Agent</h4>
      <div className="agent-definition-list">
        {agents.map((agent) => (
          <label className="agent-definition-row" key={agent.id}>
            <span>
              <strong>{agent.name}</strong>
              <small>
                {agent.id} · {agent.description}
              </small>
            </span>
            <input
              type="checkbox"
              checked={agent.enabled}
              disabled={busyId === agent.id}
              onChange={() => void toggle(agent)}
            />
          </label>
        ))}
      </div>
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </section>
  )
}

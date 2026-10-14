import { getSessionData, type SessionData } from '../../../api/sessions'
export function NodeHistory({
  history,
  action,
  onUpdate,
}: {
  history: SessionData
  action: (work: () => Promise<void>) => Promise<void>
  onUpdate: (value: SessionData) => void
}): React.JSX.Element {
  return (
    <section>
      <h4>节点轨迹</h4>
      {history.messages.map((message) => (
        <details key={message.id} open>
          <summary>
            {message.role} · {message.status}
          </summary>
          <pre>{message.content}</pre>
        </details>
      ))}
      {history.toolCalls.map((call) => (
        <details key={call.id}>
          <summary>
            {call.toolName} · {call.status}
          </summary>
          <pre>{JSON.stringify(call.output, null, 2)}</pre>
        </details>
      ))}
      {history.nextBefore && (
        <button
          type="button"
          onClick={() =>
            void action(async () => {
              const older = await getSessionData(
                history.session!.id,
                history.nextBefore!,
              )
              onUpdate({
                ...older,
                messages: [...older.messages, ...history.messages],
                toolCalls: [...older.toolCalls, ...history.toolCalls],
              })
            })
          }
        >
          加载更早轨迹
        </button>
      )}
    </section>
  )
}

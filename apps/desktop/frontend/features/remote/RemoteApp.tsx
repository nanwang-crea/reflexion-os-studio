import { useState } from 'react'
import { useRemotePairing } from './useRemotePairing'
import { RemoteChat } from './RemoteChat'

export function RemoteApp(): React.JSX.Element {
  const pairing = useRemotePairing()
  const [name, setName] = useState('我的手机')
  if (pairing.device?.approved && pairing.sessionId)
    return <RemoteChat sessionId={pairing.sessionId} />
  return (
    <main className="remote-pairing">
      <h1>连接电脑会话</h1>
      <p>模型、文件和工具继续在电脑执行。电脑需要保持运行。</p>
      {pairing.error && <p role="alert">{pairing.error}</p>}
      {pairing.device ? (
        <>
          <p>请在电脑核对以下配对码，并批准这台设备：</p>
          <strong className="remote-code">
            {pairing.device.verificationCode}
          </strong>
          <p>等待电脑确认。批准后可查看、发送消息并处理此会话审批。</p>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void pairing.pair(name)
          }}
        >
          <label htmlFor="device-name">设备名称</label>
          <input
            id="device-name"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <button className="primary" disabled={pairing.busy || !name.trim()}>
            请求连接
          </button>
        </form>
      )}
    </main>
  )
}

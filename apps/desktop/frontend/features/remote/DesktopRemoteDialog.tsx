import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { RemoteStatus } from '@reflexion-os-studio/contracts'
import {
  getRemoteStatus,
  inviteRemote,
  resolveRemoteDevice,
  revokeRemoteDevice,
  startRemote,
  stopRemote,
} from '../../api/remote'
import { Select } from '../../components/forms/Select'
import { useModalDialog } from '../../hooks/ui/useModalDialog'
import './desktop-remote.css'

export function DesktopRemoteDialog({
  sessionId,
  onClose,
}: {
  sessionId: string
  onClose: () => void
}): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialog = useModalDialog(true, closeRef)
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [address, setAddress] = useState('')
  const [qr, setQr] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async (): Promise<void> => {
    const next = await getRemoteStatus()
    setStatus(next)
    setAddress((current) => current || next.addresses[0] || '127.0.0.1')
  }, [])
  useEffect(() => {
    let disposed = false
    let pending = false
    const load = (): void => {
      if (pending) return
      pending = true
      void getRemoteStatus()
        .then((next) => {
          if (!disposed) {
            setStatus(next)
            setAddress((current) => current || next.addresses[0] || '127.0.0.1')
          }
        })
        .catch(() => {
          if (!disposed) setError('读取手机接入状态失败')
        })
        .finally(() => {
          pending = false
        })
    }
    load()
    const timer = setInterval(load, 2000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [])
  useEffect(() => {
    let disposed = false
    setQr(null)
    if (status?.invitationUrl)
      void QRCode.toDataURL(status.invitationUrl, {
        width: 240,
        margin: 2,
        errorCorrectionLevel: 'M',
      })
        .then((url) => {
          if (!disposed) setQr(url)
        })
        .catch(() => {
          if (!disposed) setError('生成二维码失败')
        })
    return () => {
      disposed = true
    }
  }, [status?.invitationUrl])
  const perform = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="dialog-overlay remote-dialog"
      aria-label="手机连接"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="dialog">
        <div className="remote-dialog-heading">
          <h3>手机连接 · 局域网</h3>
          <button ref={closeRef} className="ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        <p>
          手机扫码后复用此会话，模型和工具继续在电脑执行。关闭此窗口不会停止接入。
        </p>
        {error && <p role="alert">{error}</p>}
        {!status?.running ? (
          <>
            <label htmlFor="remote-address">电脑网络地址</label>
            <Select
              id="remote-address"
              value={address}
              onValueChange={setAddress}
              disabled={busy}
            >
              {(status?.addresses ?? []).map((item) => (
                <option key={item} value={item}>
                  {item === '127.0.0.1' ? `${item}（仅本机测试）` : item}
                </option>
              ))}
            </Select>
            <button
              className="primary"
              disabled={busy || !status}
              onClick={() =>
                void perform(() => startRemote(sessionId, address))
              }
            >
              开启并生成二维码
            </button>
          </>
        ) : (
          <>
            {status.sessionId !== sessionId && (
              <p role="status">
                当前接入绑定另一会话。需先停止，再为本会话开启。
              </p>
            )}
            <p>
              手机与电脑需在可互通的同一网络。首次打开会出现自签名证书提示；请确认地址属于这台电脑，并在浏览器核对证书指纹。受管设备可能无法接受此证书。
            </p>
            <code className="remote-fingerprint">
              证书 SHA-256：{status.fingerprint}
            </code>
            {status.invitationUrl && (
              <>
                {qr && (
                  <img
                    className="remote-qr"
                    src={qr}
                    alt="手机配对二维码"
                    width={240}
                    height={240}
                  />
                )}
                <p>二维码两分钟有效，使用一次后失效。</p>
              </>
            )}
            {!status.invitationUrl && (
              <p>邀请码已使用或已过期。连接新设备需重新生成。</p>
            )}
            <div className="remote-device-actions">
              <button
                className="ghost"
                disabled={busy}
                onClick={() => void perform(inviteRemote)}
              >
                生成新二维码
              </button>
              <button
                className="ghost"
                disabled={busy}
                onClick={() => void perform(stopRemote)}
              >
                停止接入并断开全部设备
              </button>
            </div>
            <ul className="remote-devices">
              {status.devices.map((device) => (
                <li key={device.id}>
                  <strong>{device.name}</strong>
                  <span>
                    {device.approved
                      ? '已连接授权'
                      : `待核对：${device.verificationCode}`}
                  </span>
                  {device.approved ? (
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() =>
                        void perform(() => revokeRemoteDevice(device.id))
                      }
                    >
                      撤销
                    </button>
                  ) : (
                    <>
                      <p>
                        确认手机显示相同配对码后批准。此设备将能阅读、发送消息及处理本会话与子任务审批。
                      </p>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          void perform(() =>
                            resolveRemoteDevice(device.id, true),
                          )
                        }
                      >
                        配对码一致，批准
                      </button>
                      <button
                        className="ghost"
                        disabled={busy}
                        onClick={() =>
                          void perform(() =>
                            resolveRemoteDevice(device.id, false),
                          )
                        }
                      >
                        拒绝
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted">
          电脑退出或休眠后不可连接。当前版本不提供公网中继。
        </p>
      </div>
    </dialog>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  dangerDisable,
  dangerEnable,
  dangerPrepare,
  type DangerPrepareResult,
} from '../../../api/permissions'

interface Props {
  open: boolean
  sessionId: string | null
  onClose: () => void
  /** 启用成功回调：父层经 danger.changed 事件同步 banner，这里只关闭对话框。 */
  onEnabled: () => void
}

type Step = 'intro' | 'confirm'

/**
 * Danger 两段式确认对话框（独立于普通审批卡，不进审批队列）。
 * 第一步列出跳过项与边界；"继续"调 danger.prepare 拿 capability + 到期时间；
 * 第二步必须再次点击"启用"，且不得用 Enter 默认触发。失败留在对话框显示
 * 稳定错误，绝不回退成普通完全允许。
 */
export function DangerConfirmationDialog({
  open,
  sessionId,
  onClose,
  onEnabled,
}: Props): React.JSX.Element | null {
  const [step, setStep] = useState<Step>('intro')
  const [prepared, setPrepared] = useState<DangerPrepareResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const enableRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (open) {
      setStep('intro')
      setPrepared(null)
      setError(null)
      setBusy(false)
    }
  }, [open])

  const prepare = useCallback(async () => {
    if (sessionId === null) return
    setBusy(true)
    setError(null)
    try {
      const result = await dangerPrepare(sessionId)
      setPrepared(result)
      setStep('confirm')
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setBusy(false)
    }
  }, [sessionId])

  const enable = useCallback(async () => {
    if (prepared === null) return
    setBusy(true)
    setError(null)
    try {
      await dangerEnable(prepared.challengeId)
      onEnabled()
      onClose()
    } catch (caught) {
      setError(describeError(caught))
      // challenge 已单次消费：失败回到第一步重新确认，不降级。
      setStep('intro')
      setPrepared(null)
    } finally {
      setBusy(false)
    }
  }, [prepared, onClose, onEnabled])

  const disableActive = useCallback(async () => {
    if (sessionId === null) return
    setBusy(true)
    try {
      await dangerDisable(sessionId)
      onClose()
    } finally {
      setBusy(false)
    }
  }, [sessionId, onClose])

  if (!open) return null

  const capabilityOk = prepared?.capability.supported ?? false

  return (
    <div
      className="danger-overlay"
      role="presentation"
      onKeyDown={(event) => {
        // 阻止 Enter 在第二步默认触发"启用"（无障碍红线：无默认提交键）。
        if (step === 'confirm' && event.key === 'Enter') {
          event.preventDefault()
        }
        if (event.key === 'Escape') onClose()
      }}
    >
      <div
        className="danger-dialog"
        role="alertdialog"
        aria-labelledby="danger-dialog-title"
        aria-describedby="danger-dialog-body"
      >
        <h2 id="danger-dialog-title" className="danger-dialog-title">
          ☠ 危险：系统范围完全访问
        </h2>
        {step === 'intro' && (
          <div id="danger-dialog-body" className="danger-dialog-body">
            <ul className="danger-list">
              <li>
                启用后 30 分钟内，工作区内外的文件与 Shell 操作不再逐次审批。
              </li>
              <li>Shell 命令默认联网，不再单独询问网络审批。</li>
              <li>
                机密文件（私钥 / .env / 凭据 / 本项目密钥存储）
                <strong>仍禁止读取</strong>
                ，日志脱敏与进程树回收仍生效。
              </li>
              <li>到期、会话删除、Runtime 重启或手动关闭即刻失效。</li>
            </ul>
            {error && (
              <p className="danger-error" role="alert">
                {error}
              </p>
            )}
            <div className="danger-actions">
              <button
                type="button"
                className="ghost"
                onClick={onClose}
                disabled={busy}
              >
                取消
              </button>
              <button
                type="button"
                className="danger-continue"
                onClick={() => void prepare()}
                disabled={busy || sessionId === null}
              >
                {busy ? '处理中…' : '继续'}
              </button>
            </div>
          </div>
        )}
        {step === 'confirm' && prepared && (
          <div id="danger-dialog-body" className="danger-dialog-body">
            <p>
              平台能力：
              <strong>
                {capabilityOk
                  ? `可用（${prepared.capability.provider}）`
                  : (prepared.capability.detail ?? '不可用')}
              </strong>
            </p>
            <p>
              挑战有效期至 {new Date(prepared.expiresAt).toLocaleTimeString()}
              ，仅本次、仅当前会话。
            </p>
            <p className="danger-warning">{prepared.warning}</p>
            {error && (
              <p className="danger-error" role="alert">
                {error}
              </p>
            )}
            <div className="danger-actions">
              <button
                type="button"
                className="ghost"
                onClick={disableActive}
                disabled={busy}
              >
                关闭危险访问
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setStep('intro')
                  setPrepared(null)
                }}
                disabled={busy}
              >
                返回
              </button>
              <button
                ref={enableRef}
                type="button"
                className="danger-enable"
                onClick={() => void enable()}
                disabled={busy || !capabilityOk}
                title={
                  capabilityOk
                    ? ''
                    : '当前平台缺少可验证的 credential-guard 边界'
                }
              >
                启用 30 分钟危险访问
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import './style.css'

type BootstrapSnapshot = {
  state: string
  runtimeReady: boolean
  systemReady: boolean
  detail?: string
}

const STATUS_LABELS: Record<string, string> = {
  starting: '正在启动本地 Runtime…',
  'runtime-ready': 'Chat Runtime 已就绪',
  'system-ready': '系统 Runtime 已就绪',
  'system-degraded': 'Chat 可用，工具 Runtime 不可用',
  error: '启动失败',
  stopping: '正在关闭…',
}

const statusElement = document.querySelector<HTMLElement>('#status')
const detailElement = document.querySelector<HTMLElement>('#detail')

function render(snapshot: BootstrapSnapshot): void {
  if (statusElement) {
    statusElement.textContent = STATUS_LABELS[snapshot.state] ?? snapshot.state
  }
  if (detailElement && snapshot.detail) {
    detailElement.textContent = snapshot.detail
  }
}

async function bootstrap(): Promise<UnlistenFn> {
  const unlisten = await listen<BootstrapSnapshot>(
    'bootstrap:state',
    (event) => {
      render(event.payload)
    },
  )
  render(await invoke<BootstrapSnapshot>('bootstrap_get_state'))
  return unlisten
}

void bootstrap().catch((error: unknown) => {
  render({
    state: 'error',
    runtimeReady: false,
    systemReady: false,
    detail: String(error),
  })
})

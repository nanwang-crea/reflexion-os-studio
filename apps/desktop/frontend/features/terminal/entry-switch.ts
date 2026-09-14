/**
 * 终端入口禁用开关（spec §10「发布与回滚」：入口开关可禁用新建终端）。
 * 两个来源，任一命中即禁用：
 * - `VITE_TERMINAL_DISABLED === '1'`：构建期烧入（发布包整体禁用）；
 * - localStorage `terminal.forceDisabled === '1'`：运行期逃生舱（重启生效，
 *   会话中途手工翻转时按调用点即时读取生效，无需新协议）。
 * 语义是**禁用入口（新建）**，不是卸载功能：
 * - 顶栏终端按钮隐藏、createTab/recreateTab 拒绝并提示；
 * - 已打开的终端**保持可用**——开关的职责是停止新建，静默杀掉用户
 *   正在运行的 shell 会造成数据丢失，且与回滚前"统一关闭已有终端"的
 *   运维步骤冲突（那一步属于发布流程，不属于本开关）。
 */

export const TERMINAL_DISABLED_NOTICE = '终端功能已被禁用'

const FORCE_DISABLED_KEY = 'terminal.forceDisabled'

export function isTerminalEntryDisabled(): boolean {
  return (
    import.meta.env.VITE_TERMINAL_DISABLED === '1' ||
    localStorage.getItem(FORCE_DISABLED_KEY) === '1'
  )
}

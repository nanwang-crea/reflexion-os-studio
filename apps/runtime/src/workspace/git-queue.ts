import { markOperationRunning } from '../operations/registry.js'
/** 按 workspaceRoot 串行化 git 变更命令：index.lock 互斥是硬约束。 */
const chains = new Map<string, Promise<unknown>>()

export function withGitQueue<T>(
  root: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(root) ?? Promise.resolve()
  const start = () => {
    markOperationRunning()
    return task()
  }
  const next = prev.then(start, start)
  const settled = next.catch(() => {})
  chains.set(root, settled)
  void settled.then(() => {
    if (chains.get(root) === settled) chains.delete(root)
  })
  return next
}

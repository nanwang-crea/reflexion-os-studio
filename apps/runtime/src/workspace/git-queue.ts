/** 按 workspaceRoot 串行化 git 变更命令：index.lock 互斥是硬约束。 */
const chains = new Map<string, Promise<unknown>>()

export function withGitQueue<T>(
  root: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(root) ?? Promise.resolve()
  const next = prev.then(task, task)
  chains.set(
    root,
    next.catch(() => {}),
  )
  return next
}

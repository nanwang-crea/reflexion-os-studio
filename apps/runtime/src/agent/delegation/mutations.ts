/** Root-scoped mutex for mutating calls across concurrently running descendants. */
export class RootMutationCoordinator {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

export function isMutatingTool(toolName: string): boolean {
  return (
    toolName === 'shell.execute' ||
    toolName === 'file.write' ||
    toolName === 'file.edit' ||
    toolName === 'file.delete' ||
    toolName === 'file.move' ||
    toolName === 'file.mkdir'
  )
}

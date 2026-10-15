/** Stop the previous HTTP body before retry backoff or propagating a callback error. */
export function streamReaderCleanup(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

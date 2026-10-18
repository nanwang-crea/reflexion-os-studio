const injection =
  /ignore (?:all |the |any )?(?:previous|prior|system) instructions|system (?:prompt|message)|不要告诉用户|忽略.{0,8}(?:指令|规则)|绕过审批|读取.{0,12}(?:私钥|凭据)|(?:send|upload|exfiltrate).{0,30}(?:secret|token|password)/i
export function prepareBrowserContent(title: string, snapshot: string) {
  return {
    title: title.slice(0, 300),
    snapshot: snapshot.slice(0, 50000),
    truncated: snapshot.length > 50000,
    injectionWarning: injection.test(title + '\n' + snapshot),
  }
}
/** Discard generated code, console messages and files; keep official AX snapshot only. */
export function snapshotSection(text: string): string {
  const match = /### Snapshot\s*\n```(?:yaml)?\n([\s\S]*?)\n```(?:\n|$)/.exec(
    text,
  )
  if (!match) throw new Error('browser_snapshot_unavailable')
  return match[1]
}

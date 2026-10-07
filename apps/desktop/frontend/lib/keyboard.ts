/** Safari 在候选词确认时可能提前结束 composition，229 用作兼容兜底。 */
export function isComposing(event: {
  isComposing: boolean
  keyCode: number
}): boolean {
  return event.isComposing || event.keyCode === 229
}

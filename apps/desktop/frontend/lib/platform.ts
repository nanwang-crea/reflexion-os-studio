/** 平台判定：快捷键与提示文案按 macOS / 其他平台显式分支。 */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

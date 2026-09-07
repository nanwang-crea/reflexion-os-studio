import type { editor } from 'monaco-editor'

/** Monaco 主题名常量。 */
export const THEME_NAME = 'reflexion-dark'

/** 主题 token 颜色映射。 */
export const THEME_DATA: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
    { token: 'keyword', foreground: '569cd6' },
    { token: 'string', foreground: 'ce9178' },
    { token: 'number', foreground: 'b5cea8' },
    { token: 'type', foreground: '4ec9b0' },
    { token: 'function', foreground: 'dcdcaa' },
    { token: 'variable', foreground: '9cdcfe' },
    { token: 'operator', foreground: 'd4d4d4' },
    { token: 'delimiter', foreground: 'd4d4d4' },
    { token: 'tag', foreground: '569cd6' },
    { token: 'attribute.name', foreground: '9cdcfe' },
    { token: 'attribute.value', foreground: 'ce9178' },
    { token: 'regexp', foreground: 'd16969' },
  ],
  colors: {
    'editor.background': '#1e1e1e',
    'editor.foreground': '#d4d4d4',
    'editor.lineHighlightBackground': '#2a2d2e',
    'editor.selectionBackground': '#264f78',
    'editorCursor.foreground': '#aeafad',
    'editorLineNumber.foreground': '#858585',
    'editorLineNumber.activeForeground': '#c6c6c6',
    'editorIndentGuide.background': '#404040',
    'editorIndentGuide.activeBackground': '#707070',
    'editor.selectionHighlightBackground': '#add6ff26',
    'diffEditor.insertedTextBackground': '#2ea04333',
    'diffEditor.removedTextBackground': '#f8514933',
  },
}

/** Monaco 默认编辑器选项。 */
export const DEFAULT_EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions =
  {
    fontSize: 13,
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
    fontLigatures: true,
    lineHeight: 20,
    padding: { top: 8, bottom: 8 },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
    minimap: { enabled: false },
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    wordWrap: 'off',
    automaticLayout: true,
    tabSize: 2,
  }

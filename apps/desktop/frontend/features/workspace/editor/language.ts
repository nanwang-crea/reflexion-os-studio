const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  jsx: 'javascriptreact',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  xml: 'xml',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  kt: 'kotlin',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
}

const FILENAME_MAP: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
}

/** 根据文件路径返回 Monaco language ID。 */
export function getLanguageForFile(filePath: string): string {
  const segments = filePath.split('/')
  const filename = segments[segments.length - 1] ?? ''
  if (filename in FILENAME_MAP) return FILENAME_MAP[filename] ?? 'plaintext'
  const dotIndex = filename.lastIndexOf('.')
  if (dotIndex === -1) return 'plaintext'
  const ext = filename.slice(dotIndex + 1).toLowerCase()
  return EXT_TO_LANG[ext] ?? 'plaintext'
}

/** 返回文件基名（不含目录）。 */
export function getFileName(filePath: string): string {
  const segments = filePath.split('/')
  return segments[segments.length - 1] ?? filePath
}

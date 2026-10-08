import type { ITheme } from '@xterm/xterm'
import { getResolvedTheme } from '../../lib/theme'

export function terminalTheme(): ITheme {
  if (getResolvedTheme() === 'light') {
    return {
      background: '#ffffff',
      foreground: '#202123',
      cursor: '#202123',
      selectionBackground: '#dbeafe',
      black: '#202123',
      red: '#b4232c',
      green: '#18743c',
      yellow: '#906600',
      blue: '#2454ae',
      magenta: '#8842a2',
      cyan: '#126d78',
      white: '#686a73',
      brightBlack: '#686a73',
      brightRed: '#c42b32',
      brightGreen: '#167545',
      brightYellow: '#96510b',
      brightBlue: '#2563b8',
      brightMagenta: '#9a3da7',
      brightCyan: '#087f8c',
      brightWhite: '#55565c',
    }
  }
  return {
    background: '#1e1e1e',
    foreground: '#ececec',
    cursor: '#d0d0d0',
    selectionBackground: '#3a3a3a',
  }
}

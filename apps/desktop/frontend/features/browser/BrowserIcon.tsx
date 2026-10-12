export function BrowserIcon({
  name,
}: {
  name:
    | 'back'
    | 'forward'
    | 'reload'
    | 'close'
    | 'globe'
    | 'panel'
    | 'external'
    | 'folder'
    | 'terminal'
    | 'more'
    | 'expand'
    | 'restore'
}): React.JSX.Element {
  const paths = {
    expand: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
    restore: 'M3 8h5V3M21 8h-5V3M8 21v-5H3M16 21v-5h5',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    back: 'M14 5 7 12l7 7M7 12h13',
    forward: 'm10 5 7 7-7 7M4 12h13',
    reload: 'M20 7v5h-5M20 12a8 8 0 1 0-2 6M20 7l-3-3',
    close: 'm6 6 12 12M6 18 18 6',
    globe: 'M4 12h16M12 2c5 6 5 14 0 20-5-6-5-14 0-20',
    panel: 'M3 4h18v16H3zM15 4v16',
    external: 'M14 3h7v7M21 3 10 14M10 4H4v16h16v-6',
    folder: 'M3 7V4h7l3 3h8v13H3z',
    terminal: 'm5 7 5 5-5 5M13 17h6',
  }
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'globe' && <circle cx="12" cy="12" r="10" />}
      <path d={paths[name]} />
    </svg>
  )
}

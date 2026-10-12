;(() => {
  const center = () => {
    const root = document.scrollingElement
    if (!root || location.hash || root.scrollLeft !== 0) return
    const overflow = root.scrollWidth - root.clientWidth
    if (overflow <= 0) return
    const direction = getComputedStyle(root).direction === 'rtl' ? -1 : 1
    window.scrollTo({
      left: (direction * overflow) / 2,
      top: window.scrollY,
      behavior: 'instant',
    })
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', center, { once: true })
  } else center()
})()

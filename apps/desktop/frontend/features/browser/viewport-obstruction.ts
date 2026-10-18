const overlays =
  'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper], [data-browser-occluder], [role="menu"], [role="listbox"], [role="tooltip"]'

/** Native webpage views sit above DOM overlays, regardless of their z-index. */
export function isBrowserViewportBlocked(viewport: DOMRect): boolean {
  return [...document.querySelectorAll<HTMLElement>(overlays)].some(
    (element) => {
      // Roles inside closed dialogs and retained hidden panels are not overlays.
      if (element.closest('dialog:not([open]), [hidden]')) return false
      for (
        let parent: HTMLElement | null = element;
        parent;
        parent = parent.parentElement
      ) {
        const style = getComputedStyle(parent)
        if (style.display === 'none' || style.visibility === 'hidden')
          return false
      }
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      // Accessibility roles do not imply modality. Only actual modal dialogs
      // isolate the entire window; other surfaces block overlapping bounds.
      if (element.matches(':modal, [aria-modal="true"]')) return true
      return (
        rect.left < viewport.right &&
        rect.right > viewport.left &&
        rect.top < viewport.bottom &&
        rect.bottom > viewport.top
      )
    },
  )
}

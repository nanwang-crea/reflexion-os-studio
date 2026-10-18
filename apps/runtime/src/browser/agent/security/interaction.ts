import type { Page } from 'playwright'
import { isSafeAgentBrowserUrl } from '@reflexion-os-studio/contracts'

const payment = /credit.?card|card.?number|cc-|cvc|cvv|支付|付款/i

/** Read control metadata only. Never read input values or execute model code. */
export async function checkInteractionTarget(
  page: Page,
  ref: string,
  typing: boolean,
  submit: boolean,
) {
  const locator = page.locator(`aria-ref=${ref}`)
  const metadata = await locator
    .evaluate(
      (element) => {
        const attrs = [
          'type',
          'name',
          'id',
          'autocomplete',
          'aria-label',
          'placeholder',
          'role',
        ]
        const formId = element.getAttribute('form')
        const form = formId
          ? element.ownerDocument.getElementById(formId)
          : element.closest('form')
        return {
          tag: element.tagName.toLowerCase(),
          type: (element.getAttribute('type') ?? '').toLowerCase(),
          editable: element.getAttribute('contenteditable') === 'true',
          labels: attrs
            .map((name) => element.getAttribute(name) ?? '')
            .join(' '),
          href: element.closest('a')?.getAttribute('href') ?? null,
          target: element.closest('a')?.getAttribute('target') ?? null,
          formAction:
            element.getAttribute('formaction') ??
            form?.getAttribute('action') ??
            null,
          formMethod:
            element.getAttribute('formmethod') ??
            form?.getAttribute('method') ??
            'get',
        }
      },
      undefined,
      { timeout: 5000 },
    )
    .catch(() => {
      throw new Error('browser_page_stale')
    })
  if (
    payment.test(metadata.labels) ||
    ['file', 'hidden'].includes(metadata.type)
  )
    throw new Error('browser_interaction_denied')
  if (
    typing &&
    !(
      metadata.editable ||
      metadata.tag === 'textarea' ||
      (metadata.tag === 'input' &&
        [
          '',
          'text',
          'search',
          'url',
          'email',
          'tel',
          'number',
          'password',
        ].includes(metadata.type))
    )
  )
    throw new Error('browser_interaction_denied')
  if (metadata.href) {
    const url = new URL(metadata.href, page.url())
    if (
      !isSafeAgentBrowserUrl(url.href) ||
      url.origin !== new URL(page.url()).origin ||
      (metadata.target && metadata.target !== '_self')
    )
      throw new Error('browser_interaction_denied')
  }
  if ((!typing || submit) && metadata.formAction) {
    const url = new URL(metadata.formAction, page.url())
    if (
      !isSafeAgentBrowserUrl(url.href) ||
      url.origin !== new URL(page.url()).origin
    )
      throw new Error('browser_interaction_denied')
  }
  if ((!typing || submit) && metadata.formMethod.toLowerCase() !== 'get')
    throw new Error('browser_interaction_denied')
}

export function assertSnapshotTarget(
  snapshot: string | undefined,
  ref: string,
  element: string,
): void {
  const line = snapshot
    ?.split('\n')
    .find((line) => line.includes(`[ref=${ref}]`))
  if (!line) throw new Error('browser_page_stale')
  const named = /"((?:[^"\\]|\\.)*)"/.exec(line)
  const label = named
    ? JSON.parse(`"${named[1]}"`)
    : line.trim().replace(/^-\s*/, '').split(/[ \[]/)[0]
  if (
    element !== label ||
    /\b(?:pay|checkout|purchase)\b|支付|付款/i.test(label)
  )
    throw new Error('browser_interaction_denied')
}

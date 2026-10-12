// Embedded as a function expression by the native guest adapters.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function fillContact(c, expectedUrl, expectedOrigin) {
  if (
    window.top !== window.self ||
    location.protocol !== 'https:' ||
    location.href !== expectedUrl ||
    location.origin !== expectedOrigin
  )
    return false
  const fields = Object.assign(Object.create(null), {
    name: c.name,
    email: c.email,
    tel: c.phone,
    'street-address': c.address,
  })
  let count = 0
  for (const input of document.querySelectorAll(
    'input[autocomplete],textarea[autocomplete]',
  )) {
    const key = input.autocomplete.trim().split(/\s+/).at(-1)
    if (
      !fields[key] ||
      input.type === 'password' ||
      input.type === 'hidden' ||
      input.disabled ||
      input.readOnly ||
      !input.getClientRects().length
    )
      continue
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(
      input,
      fields[key],
    )
    count++
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  return count > 0
}

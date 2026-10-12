import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(
  new URL('../src-tauri/src/browser/platform/contact-fill.js', import.meta.url),
  'utf8',
)
function page({ frame = false, url = 'https://example.test/contact' } = {}) {
  class Input {
    constructor(autocomplete, type = 'text') {
      this.autocomplete = autocomplete
      this.type = type
      this.events = []
    }
    getClientRects() {
      return [1]
    }
    dispatchEvent(event) {
      this.events.push(event.type)
    }
    set value(value) {
      this.written = value
    }
  }
  const inputs = [
    new Input('name'),
    new Input('email', 'password'),
    new Input('constructor'),
    new Input('tel'),
  ]
  inputs[3].readOnly = true
  const window = { self: {}, top: {} }
  if (!frame) window.top = window.self
  const context = vm.createContext({
    window,
    location: { protocol: 'https:', origin: 'https://example.test', href: url },
    document: { querySelectorAll: () => inputs },
    HTMLInputElement: Input,
    HTMLTextAreaElement: class {},
    Event: class {
      constructor(type) {
        this.type = type
      }
    },
  })
  const fill = vm.runInContext(`(${source})`, context)
  return {
    inputs,
    fill: () =>
      fill(
        {
          name: 'Synthetic Person',
          email: 'example@example.test',
          phone: 'synthetic',
        },
        'https://example.test/contact',
        'https://example.test',
      ),
  }
}

test('contact fill refuses subframes and changed pages', () => {
  for (const options of [
    { frame: true },
    { url: 'https://example.test/other' },
  ]) {
    const sample = page(options)
    assert.equal(sample.fill(), false)
    assert.ok(sample.inputs.every((input) => input.written === undefined))
  }
})
test('contact fill skips password, readonly and prototype keys; emits field events', () => {
  const sample = page()
  assert.equal(sample.fill(), true)
  assert.equal(sample.inputs[0].written, 'Synthetic Person')
  assert.deepEqual(sample.inputs[0].events, ['input', 'change'])
  assert.ok(
    sample.inputs.slice(1).every((input) => input.written === undefined),
  )
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

// 用受控 hook 生命周期与延迟 RPC 检查组件本身的请求隔离，不执行真实授权。
const result = await build({
  entryPoints: [
    'frontend/features/chat/approvals/DangerConfirmationDialog.tsx',
  ],
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  bundle: true,
  format: 'esm',
  write: false,
  jsx: 'automatic',
  plugins: [
    {
      name: 'controlled-dialog-runtime',
      setup(build) {
        build.onResolve(
          {
            filter:
              /^(react|react\/jsx-runtime)$|useModalDialog$|api\/permissions$/,
          },
          (args) => ({ path: args.path, namespace: 'mock' }),
        )
        build.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
          contents:
            args.path === 'react'
              ? `export const useState = (...a) => globalThis.dialogHarness.useState(...a)
               export const useRef = (...a) => globalThis.dialogHarness.useRef(...a)
               export const useEffect = (...a) => globalThis.dialogHarness.useEffect(...a)
               export const useCallback = (callback) => callback`
              : args.path === 'react/jsx-runtime'
                ? `export const jsx = (type, props) => ({type, props}); export const jsxs = jsx`
                : args.path.endsWith('useModalDialog')
                  ? `export const useModalDialog = () => ({current: null})`
                  : `export const dangerPrepare = (...a) => globalThis.dialogHarness.prepare(...a)
                   export const dangerEnable = (...a) => globalThis.dialogHarness.enable(...a)
                   export const dangerDisable = (...a) => globalThis.dialogHarness.disable(...a)`,
        }))
      },
    },
  ],
})
const { DangerConfirmationDialog } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(result.outputFiles[0].text).toString('base64')
)

function harness() {
  const slots = []
  let cursor = 0
  let effects = []
  const pending = []
  const calls = { closed: 0, enabled: 0 }
  const h = {
    useState(initial) {
      const index = cursor++
      slots[index] ??= { value: initial }
      return [
        slots[index].value,
        (value) => {
          slots[index].value = value
        },
      ]
    },
    useRef(initial) {
      const index = cursor++
      return (slots[index] ??= { current: initial })
    },
    useEffect(callback, deps) {
      const index = cursor++
      const previous = slots[index]
      if (previous && deps.every((value, i) => value === previous.deps[i]))
        return
      effects.push(() => {
        previous?.cleanup?.()
        slots[index] = { deps, cleanup: callback() }
      })
    },
    prepare: () => new Promise((resolve) => pending.push(resolve)),
    enable: () => new Promise((resolve) => pending.push(resolve)),
    disable: async () => {
      throw new Error('Runtime disconnected')
    },
    render(open = true, sessionId = 'session-a') {
      globalThis.dialogHarness = h
      cursor = 0
      effects = []
      const tree = DangerConfirmationDialog({
        open,
        sessionId,
        onClose: () => {
          calls.closed++
        },
        onEnabled: () => {
          calls.enabled++
        },
      })
      effects.forEach((effect) => effect())
      return tree
    },
    pending,
    calls,
  }
  return h
}
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return undefined
  if (predicate(tree)) return tree
  for (const child of [tree.props?.children].flat(Infinity)) {
    const result = find(child, predicate)
    if (result) return result
  }
}
const button = (tree, text) =>
  find(tree, (node) => node.type === 'button' && node.props.children === text)
const prepared = {
  challengeId: 'challenge-a',
  expiresAt: Date.now() + 60000,
  capability: { supported: true, provider: 'mock' },
  warning: 'mock',
}
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

test('关闭重开与切换会话忽略旧 prepare 响应，旧 finally 不解锁新请求', async () => {
  const h = harness()
  let tree = h.render()
  button(tree, '继续').props.onClick()
  tree.props.onCancel({ preventDefault() {} })
  h.render(false)
  h.render(true)
  tree = h.render(true)
  button(tree, '继续').props.onClick()
  h.pending.shift()(prepared)
  await flush()
  tree = h.render()
  assert.ok(button(tree, '处理中…'))
  h.render(true, 'session-b')
  h.pending.shift()(prepared)
  await flush()
  tree = h.render(true, 'session-b')
  assert.ok(button(tree, '继续'))
  assert.equal(button(tree, '启用 30 分钟危险访问'), undefined)
})

test('旧 enable 响应不会关闭重开的弹窗或触发成功回调', async () => {
  const h = harness()
  button(h.render(), '继续').props.onClick()
  h.pending.shift()(prepared)
  await flush()
  let tree = h.render()
  button(tree, '启用 30 分钟危险访问').props.onClick()
  tree.props.onCancel({ preventDefault() {} })
  h.render(false)
  h.render(true)
  h.pending.shift()()
  await flush()
  tree = h.render()
  assert.ok(button(tree, '继续'))
  assert.equal(h.calls.closed, 1)
  assert.equal(h.calls.enabled, 0)
})

test('关闭危险访问失败显示错误并允许重试', async () => {
  const h = harness()
  button(h.render(), '继续').props.onClick()
  h.pending.shift()(prepared)
  await flush()
  await button(h.render(), '关闭危险访问').props.onClick()
  const tree = h.render()
  assert.equal(
    find(tree, (node) => node.props?.role === 'alert').props.children,
    'Runtime disconnected',
  )
  assert.equal(button(tree, '关闭危险访问').props.disabled, false)
  assert.equal(h.calls.closed, 0)
})

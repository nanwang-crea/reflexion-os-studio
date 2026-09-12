# 编辑器 UX 优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 聊天列宽自适应 + 文件脏标识（圆点/关闭拦截/切项目拦截/关窗口拦截）+ 快捷键（保存/关标签）+ 标签条与编辑器头部 UI 重构。

**Architecture:** 脏状态从 `MonacoSurface` 上收至 `useWorkspacePanel`（`dirtyPaths: Set<string>`）；文本类标签保活（非激活 `display:none`）使未保存内容跨切换存活；`FileViewerPanel` 拆出 `FileTabs.tsx` 并持有 surface 句柄注册表，经 ref 暴露 `saveDirty/saveAllDirty`；App 层 `useWorkspaceTabGuard` 编排三键确认弹窗与热键。

**Tech Stack:** React 19（ref-as-prop）、TypeScript strict、@monaco-editor/react、@tauri-apps/api 2。

**Spec:** `docs/superpowers/specs/2026-09-12-editor-ux-polish-design.md`

**重要约定：**

- **不要 commit**。用户未要求提交；全部改动留在工作区，最终统一 review。工作区已有其他未提交改动，属于用户在途工作，**不要触碰与本计划无关的文件**。
- 本仓库前端无单测基础设施；每任务的验证 = `pnpm --filter @reflexion-os-studio/desktop typecheck` + `pnpm lint`（Task 11 跑全量）。
- 遵守 AGENTS.md：无注释除非必要、单引号无分号、行宽 80、文件 500 行硬上限、Prettier 格式（可用 `pnpm format` 局部整理，不要跑全仓 format 以免碰无关文件——用 `npx prettier --write <file>` 针对改动文件）。

---

### Task 1: 聊天列宽加宽

**Files:**

- Modify: `apps/desktop/frontend/styles/style.css:26`

- [ ] **Step 1: 修改 CSS 变量**

```css
/* 聊天列宽：transcript/输入区/悬浮卡对齐共用，改一处即可整体同步。
     上限加宽：窗口最大化时消息区跟随变宽，超宽屏行长封顶。 */
--chat-col: min(1200px, 85%);
```

（替换原 `--chat-col: 760px;` 行；`chat.css` 中 6 处使用点无需改动。）

- [ ] **Step 2: 验证**

Run: `pnpm --filter @reflexion-os-studio/desktop typecheck`
Expected: 无错误

- [ ] **Step 3: 针对性格式化**

Run: `npx prettier --write apps/desktop/frontend/styles/style.css`

---

### Task 2: 平台常量 + ConfirmDialog 第三键 + confirmAction

**Files:**

- Create: `apps/desktop/frontend/lib/platform.ts`
- Modify: `apps/desktop/frontend/components/ConfirmDialog.tsx`
- Modify: `apps/desktop/frontend/hooks/useConfirmDialog.ts`

- [ ] **Step 1: 新建 `lib/platform.ts`**

```ts
/** 平台判定：快捷键与提示文案按 macOS / 其他平台显式分支。 */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
```

- [ ] **Step 2: ConfirmDialog 支持第三键**

`ConfirmDialogState` 增加字段：

```ts
export interface ConfirmDialogState {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** 危险操作（如删除）时确认按钮显示为红色。 */
  danger?: boolean
  /** 可选第三键文案（如"不保存"）；设置后需同步传入 onTertiary。 */
  tertiaryLabel?: string
}
```

`ConfirmDialogProps` 增加 `onTertiary?: () => void`；`.dialog-actions` 内在取消与确认之间插入：

```tsx
<div className="dialog-actions">
  <button ref={cancelRef} className="ghost" onClick={props.onCancel}>
    {state.cancelLabel ?? '取消'}
  </button>
  {state.tertiaryLabel !== undefined && props.onTertiary !== undefined && (
    <button className="ghost" onClick={props.onTertiary}>
      {state.tertiaryLabel}
    </button>
  )}
  <button
    className={state.danger ? 'dialog-danger' : ''}
    onClick={props.onConfirm}
  >
    {state.confirmLabel ?? '确定'}
  </button>
</div>
```

- [ ] **Step 3: useConfirmDialog 增加 promise 三态 API**

完整替换 `hooks/useConfirmDialog.ts`：

```ts
import { useCallback, useRef, useState } from 'react'
import type { ConfirmDialogState } from '../components/ConfirmDialog'

/** 三键弹窗的结算结果：confirm=主确认，tertiary=第三键，cancel=取消/Esc。 */
export type ConfirmResult = 'confirm' | 'tertiary' | 'cancel'

export interface ConfirmDialogHandle {
  confirmState: ConfirmDialogState | null
  /** 应用内确认弹窗：promise 风格，供变更类操作等待用户决定。 */
  confirm: (state: ConfirmDialogState) => Promise<boolean>
  /** 三键版本：需要区分"主确认/第三键/取消"时使用。 */
  confirmAction: (state: ConfirmDialogState) => Promise<ConfirmResult>
  handleConfirm: () => void
  handleTertiary: () => void
  handleCancel: () => void
}

export function useConfirmDialog(): ConfirmDialogHandle {
  const [confirmState, setConfirmState] = useState<ConfirmDialogState | null>(
    null,
  )
  const resolverRef = useRef<((result: ConfirmResult) => void) | null>(null)

  const confirmAction = useCallback(
    (state: ConfirmDialogState): Promise<ConfirmResult> => {
      return new Promise((resolve) => {
        // 理论上不会连开两个弹窗；万一发生，先了结旧 promise 避免挂起。
        resolverRef.current?.('cancel')
        resolverRef.current = resolve
        setConfirmState(state)
      })
    },
    [],
  )

  const confirm = useCallback(
    async (state: ConfirmDialogState): Promise<boolean> =>
      (await confirmAction(state)) === 'confirm',
    [confirmAction],
  )

  const settle = useCallback((result: ConfirmResult): void => {
    setConfirmState(null)
    resolverRef.current?.(result)
    resolverRef.current = null
  }, [])

  const handleConfirm = useCallback(() => settle('confirm'), [settle])
  const handleTertiary = useCallback(() => settle('tertiary'), [settle])
  const handleCancel = useCallback(() => settle('cancel'), [settle])

  return {
    confirmState,
    confirm,
    confirmAction,
    handleConfirm,
    handleTertiary,
    handleCancel,
  }
}
```

既有调用方（SettingsView / MemoryView / AssetsPanel / useSessionActions 等）用 `confirm()` 布尔 API，保持兼容；App 中 `<ConfirmDialog>` 需要新增 `onTertiary={handleTertiary}`（Task 10 接线，此处先不动 App，typecheck 仍应通过）。

- [ ] **Step 4: 验证**

Run: `pnpm --filter @reflexion-os-studio/desktop typecheck && pnpm lint`
Expected: 通过

---

### Task 3: useWorkspacePanel 脏状态

**Files:**

- Modify: `apps/desktop/frontend/hooks/useWorkspacePanel.ts`

- [ ] **Step 1: 增加状态与动作**

imports 增加（react 已有 useState/useCallback，无需新增 import 之外的内容）。在 `WorkspacePanelState` 接口增加：

```ts
  /** 已修改未保存的文件路径集合（文本类标签）。 */
  dirtyPaths: Set<string>
  /** 编辑内核脏状态上抛入口（值不变时 no-op，防键击级重渲染）。 */
  setTabDirty: (path: string, dirty: boolean) => void
```

hook 内新增：

```ts
const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(() => new Set())

const setTabDirty = useCallback((path: string, dirty: boolean): void => {
  setDirtyPaths((prev) => {
    if (prev.has(path) === dirty) return prev
    const next = new Set(prev)
    if (dirty) next.add(path)
    else next.delete(path)
    return next
  })
}, [])
```

- [ ] **Step 2: closeTab / resetWorkspaceFiles 清理脏标记**

`closeTab` 内（`setOpenTabs` 调用之后、返回 `next` 之前的同层位置，不要放进 updater）追加：

```ts
setDirtyPaths((prev) => {
  if (!prev.has(path)) return prev
  const next = new Set(prev)
  next.delete(path)
  return next
})
```

`resetWorkspaceFiles` 内追加 `setDirtyPaths(new Set())`。

返回对象增加 `dirtyPaths, setTabDirty`。

- [ ] **Step 3: 验证**

Run: `pnpm --filter @reflexion-os-studio/desktop typecheck && pnpm lint`
Expected: 通过（App 尚未消费新状态也无妨）

---

### Task 4: MonacoSurface — save 返回布尔 + Monaco 内 Cmd+S

**Files:**

- Modify: `apps/desktop/frontend/features/workspace/editor/MonacoSurface.tsx`

- [ ] **Step 1: handle.save 返回成功布尔**

接口改为：

```ts
export interface MonacoSurfaceHandle {
  save: () => Promise<boolean>
  setEditMode: (editMode: boolean) => void
  copyText: () => Promise<void>
}
```

`handleSave` 改为（错误仍上抛到头部错误提示，调用方据返回值决定是否继续关闭/切换）：

```ts
const handleSave = useCallback(async (): Promise<boolean> => {
  if (content === null || saving || !canEdit) return false
  setSaving(true)
  try {
    await writeFile(projectId, path, content)
    setBaseline(content)
    return true
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err))
    return false
  } finally {
    setSaving(false)
  }
}, [content, saving, canEdit, projectId, path])
```

- [ ] **Step 2: Monaco 内绑定 Cmd/Ctrl+S**

Monaco 会吞掉编辑器聚焦时的 keydown，全局监听收不到，需在编辑器内注册。用 ref 打破闭包陈旧（handleSave 随键击重建）：

```ts
const handleSaveRef = useRef(handleSave)
handleSaveRef.current = handleSave
```

`handleEditorMount` 改为：

```ts
const handleEditorMount: OnMount = useCallback((editor, monaco) => {
  editorRef.current = editor
  monaco.editor.defineTheme(THEME_NAME, THEME_DATA)
  monaco.editor.setTheme(THEME_NAME)
  // Monaco 自吞 keydown：编辑器内的保存快捷键在此注册（编辑器外由
  // useAppHotkeys 全局兜底，两者汇到同一 handleSave）。
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    void handleSaveRef.current()
  })
}, [])
```

（注意：`monaco.KeyMod` / `monaco.KeyCode` 来自 OnMount 回调参数，**不要**从 `'monaco-editor'` 运行时 import。）

- [ ] **Step 3: 验证**

Run: `pnpm --filter @reflexion-os-studio/desktop typecheck && pnpm lint`
Expected: 通过

---

### Task 5: MonacoEditor — 脏链路上抛 + 句柄注册 + 头部重排

**Files:**

- Modify: `apps/desktop/frontend/features/workspace/editor/types.ts`
- Modify: `apps/desktop/frontend/features/workspace/editor/MonacoEditor.tsx`
- Modify: `apps/desktop/frontend/features/workspace/editor/monaco.ts`

- [ ] **Step 1: MonacoEditorProps 增加回调**

```ts
/** 编辑内核脏状态上抛（仅脏/净切换时触发）。 */
export interface MonacoEditorProps {
  projectId: string
  path: string
  initialLine?: number
  readOnly?: boolean
  onClose: () => void
  onContentChange?: (content: string) => void
  onDirtyChange?: (path: string, dirty: boolean) => void
  /** 注册 surface 句柄 getter（null 注销）；getter 调用时才解引用，规避闭包陈旧。 */
  registerSurface?: (
    path: string,
    getter: (() => MonacoSurfaceHandle | null) | null,
  ) => void
}
```

（需要 `import type { MonacoSurfaceHandle } from './MonacoSurface'`；types.ts 现只含类型与常量，加 type import 不引入循环——MonacoSurface 不 import types.ts 中的 MonacoEditorProps，确认无环。）

- [ ] **Step 2: MonacoEditor 头部重排 + 脏圆点 + 注册效果**

完整替换 `MonacoEditor.tsx`：

```tsx
/**
 * Monaco 单文件编辑器完整视图：头部（文件名+脏圆点居左，操作按钮组
 * 右对齐含关闭×）+ 无头内核 MonacoSurface。加载/编辑/脏跟踪/保存逻辑
 * 都在 Surface；脏状态与句柄经 props 上抛给标签层。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MonacoSurface,
  type MonacoSurfaceHandle,
  type MonacoSurfaceState,
} from './MonacoSurface'
import { getFileName } from './language'
import type { MonacoEditorProps } from './types'
import { IS_MAC } from '../../../lib/platform'

export function MonacoEditor(props: MonacoEditorProps): React.JSX.Element {
  const [surface, setSurface] = useState<MonacoSurfaceState>({
    loading: true,
    error: null,
    dirty: false,
    saving: false,
    canEdit: false,
    editMode: false,
  })
  const surfaceRef = useRef<MonacoSurfaceHandle>(null)
  const fileName = getFileName(props.path)
  const editable = props.readOnly !== true

  const handleStateChange = useCallback(
    (state: MonacoSurfaceState): void => {
      setSurface(state)
      props.onDirtyChange?.(props.path, state.dirty)
    },
    [props.onDirtyChange, props.path],
  )

  // 注册句柄 getter：标签层经它在任意时刻拿到最新 handle（useImperativeHandle
  // 随内容变化重建 handle，getter 延迟解引用规避陈旧闭包）。
  const { registerSurface } = props
  useEffect(() => {
    registerSurface?.(props.path, () => surfaceRef.current)
    return () => registerSurface?.(props.path, null)
  }, [props.path, registerSurface])

  return (
    <div className="content-view monaco-editor-container">
      <header className="content-head">
        <div className="content-head-main">
          <span className="content-name" title={props.path}>
            {fileName}
          </span>
          {surface.dirty && (
            <span className="content-dirty-dot" aria-label="未保存" />
          )}
        </div>
        <div className="content-head-actions">
          <button
            className="ghost"
            onClick={() => void surfaceRef.current?.copyText()}
            title="复制全文"
          >
            复制
          </button>
          {editable && (
            <>
              <button
                className={`ghost${surface.editMode ? ' active' : ''}`}
                onClick={() =>
                  surfaceRef.current?.setEditMode(!surface.editMode)
                }
                disabled={!surface.canEdit}
                title={
                  surface.canEdit
                    ? surface.editMode
                      ? '切换为只读'
                      : '切换为编辑'
                    : '文件过大或读取被截断，仅支持只读'
                }
              >
                {surface.editMode ? '编辑中' : '只读'}
              </button>
              <button
                className="ghost"
                onClick={() => void surfaceRef.current?.save()}
                disabled={!surface.dirty || surface.saving}
                title={IS_MAC ? '保存（⌘S）' : '保存（Ctrl+S）'}
              >
                {surface.saving ? '保存中…' : '保存'}
              </button>
            </>
          )}
          <button
            className="ghost content-close"
            onClick={props.onClose}
            aria-label="关闭"
            title="关闭"
          >
            ×
          </button>
        </div>
        {surface.error !== null && (
          <span className="content-error-inline">{surface.error}</span>
        )}
      </header>
      <MonacoSurface
        projectId={props.projectId}
        path={props.path}
        initialLine={props.initialLine}
        readOnly={props.readOnly}
        ref={surfaceRef}
        onStateChange={handleStateChange}
        onContentChange={props.onContentChange}
      />
    </div>
  )
}
```

- [ ] **Step 3: 字号微调（monaco.ts）**

`DEFAULT_EDITOR_OPTIONS` 中 `fontSize: 13,` → `fontSize: 14,`；`lineHeight: 20,` → `lineHeight: 21,`。

- [ ] **Step 4: 验证**

Run: `pnpm --filter @reflexion-os-studio/desktop typecheck && pnpm lint`
Expected: 通过

---

### Task 6: ContentView 透传

**Files:**

- Modify: `apps/desktop/frontend/features/workspace/ContentView.tsx`

- [ ] **Step 1: 接口与透传**

```tsx
import { MonacoEditor } from './editor/MonacoEditor'

interface ContentViewProps {
  projectId: string
  path: string
  initialLine?: number
  readOnly?: boolean
  onClose: () => void
  onDirtyChange?: (path: string, dirty: boolean) => void
  registerSurface?: (
    path: string,
    getter:
      | (() => import('./editor/MonacoSurface').MonacoSurfaceHandle | null)
      | null,
  ) => void
}

/**
 * Monaco 单文件编辑器：替代原有纯文本行渲染，提供语法高亮、折叠、
 * 搜索、编辑/保存。默认只读，可通过编辑按钮切换。
 */
export function ContentView(props: ContentViewProps): React.JSX.Element {
  return (
    <MonacoEditor
      projectId={props.projectId}
      path={props.path}
      initialLine={props.initialLine}
      readOnly={props.readOnly ?? true}
      onClose={props.onClose}
      onDirtyChange={props.onDirtyChange}
      registerSurface={props.registerSurface}
    />
  )
}
```

（`import()` 类型内联可读性差，建议改为文件顶部 `import type { MonacoSurfaceHandle } from './editor/MonacoSurface'` 后用普通类型引用——两种写法均可，以顶部 import 为准。）

- [ ] **Step 2: 验证**

Run: `pnpm --filter @reflexion-os-studio/desktop typecheck && pnpm lint`

---

### Task 7: MarkdownFilePreview — 脏链路 + 句柄注册 + 模式切换守卫

**Files:**

- Modify: `apps/desktop/frontend/features/workspace/preview/MarkdownFilePreview.tsx`

- [ ] **Step 1: Props 扩展**

```ts
import type { ConfirmDialogState } from '../../../components/ConfirmDialog'
import type { MonacoSurfaceHandle } from '../editor/MonacoSurface'

interface MarkdownFilePreviewProps {
  projectId: string
  path: string
  /** 资源引用（workspace:// asset:// https://）点击回调；宿主按类型分发。 */
  onResourceClick?: (link: ResourceLink) => void
  /** 源码模式下编辑内核脏状态上抛（预览模式恒为 false）。 */
  onDirtyChange?: (path: string, dirty: boolean) => void
  /** 注册 surface 句柄 getter（null 注销），供标签层保存/守卫使用。 */
  registerSurface?: (
    path: string,
    getter: (() => MonacoSurfaceHandle | null) | null,
  ) => void
  /** 应用级确认弹窗（promise 风格），源码→预览丢弃守卫用。 */
  confirm?: (state: ConfirmDialogState) => Promise<boolean>
}
```

- [ ] **Step 2: 状态上报与注册**

```ts
const handleSurfaceState = useCallback((state: MonacoSurfaceState): void => {
  setSurfaceState(state)
  // 仅源码模式存在未保存修改；回预览即视为净态。
  props.onDirtyChange?.(props.path, props.modeDirtySource ?? (false && false))
}, [])
```

上面是**错误示范**——直接按下面实现：把 mode 纳入 deps，state 与 mode 双路径都上报：

```ts
const handleSurfaceState = useCallback(
  (state: MonacoSurfaceState): void => {
    setSurfaceState(state)
    props.onDirtyChange?.(props.path, mode === 'source' && state.dirty)
  },
  [mode, props.onDirtyChange, props.path],
)

const { registerSurface, path } = props
useEffect(() => {
  registerSurface?.(path, () => surfaceRef.current)
  return () => registerSurface?.(path, null)
}, [path, registerSurface])
```

（需 `import { useEffect } from 'react'`；getter 在预览模式下解引用为 null——MonacoSurface 未挂载时 surfaceRef.current 本就是 null，安全。）

- [ ] **Step 3: 模式切换守卫**

`handleViewModeChange` 替换为（切换回预览时同时上报净态）：

```ts
const handleViewModeChange = useCallback(
  (next: MarkdownPreviewViewMode): void => {
    if (next === mode) return
    if (next === 'preview' && mode === 'source') {
      if (surfaceState?.dirty === true && confirm !== undefined) {
        void (async () => {
          const ok = await confirm({
            title: '有未保存的修改',
            message: `${fileName} 的源码修改尚未保存，切换到预览将丢弃。`,
            confirmLabel: '放弃修改并预览',
            danger: true,
          })
          if (!ok) return
          onDirtyChangeSafe(path, false)
          setMode('preview')
          setReloadTick((tick) => tick + 1)
        })()
        return
      }
      onDirtyChangeSafe(path, false)
    }
    setMode(next)
    if (next === 'preview') {
      setReloadTick((tick) => tick + 1)
    } else {
      setSurfaceState(null)
    }
  },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [mode, surfaceState?.dirty, confirm, fileName, path],
)
```

其中辅助函数（组件内、上述回调之前定义）：

```ts
const onDirtyChangeSafe = useCallback(
  (targetPath: string, dirty: boolean): void => {
    props.onDirtyChange?.(targetPath, dirty)
  },
  [props.onDirtyChange],
)
```

若 lint 对 `surfaceState?.dirty` 依赖项有意见，改为把 `const dirtyNow = surfaceState?.dirty === true` 提为普通变量并纳入 deps（`dirtyNow`）。禁止用 eslint-disable 除非确实无法消除。

- [ ] **Step 4: 传递给 MonacoSurface**

JSX 中 `<MonacoSurface ... onStateChange={handleSurfaceState} />` 不变（已接）。确认 `registerSurface` 效果已加（Step 2）。

- [ ] **Step 5: 验证**

Run: `pnpm --filter @reflexion-os-studio/desktop typecheck && pnpm lint`
Expected: 通过

---

### Task 8: 拆出 FileTabs.tsx + 标签条 VS Code 风格

**Files:**

- Create: `apps/desktop/frontend/features/workspace/FileTabs.tsx`
- Modify: `apps/desktop/frontend/features/workspace/FileViewerPanel.tsx`（此任务只移除标签条部分，其余 Task 9 处理）
- Modify: `apps/desktop/frontend/features/workspace/workspace.css`
- Modify: `apps/desktop/frontend/styles/style.css`（新增 `--bg-editor`）

- [ ] **Step 1: 新建 FileTabs.tsx**

把 FileViewerPanel 中的标签条（含拖拽排序、自绘滚动条）整体迁出为独立组件，并加入脏圆点。完整内容：

```tsx
/**
 * 文件标签条：多文件顶部标签 + 拖拽排序 + 自定义横向滚动条 + 脏圆点。
 * 拖拽用 pointer events 自绘（不依赖原生 HTML5 DnD——后者在 Tauri 各平台
 * WebView 行为不一致）：按下只登记候选、不捕获指针，移动超过阈值才进入
 * 拖动态；被拖标签原位半透明 + 虚线框，插入指示线实时预览落点，松手一次
 * 性提交新顺序。脏标签以圆点替代关闭 ×，hover 时圆点变回 ×（VS Code 行为）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OpenFileTab } from './types'

/** 转义 CSS 选择器属性值中的特殊字符，路径可含 `.`、`/` 等。 */
function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`)
}

interface FileTabsProps {
  openTabs: OpenFileTab[]
  activePath: string | null
  dirtyPaths: Set<string>
  onSelectTab: (path: string) => void
  onCloseTab: (path: string) => void
  /** 拖拽排序完成后回调：paths 为新的打开顺序。 */
  onReorderTabs: (paths: string[]) => void
}

export function FileTabs(props: FileTabsProps): React.JSX.Element {
  const tabsScrollRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [canScroll, setCanScroll] = useState(false)
  const [scrollRatio, setScrollRatio] = useState(0)
  const [thumbRatio, setThumbRatio] = useState(1)
  const [trackWidth, setTrackWidth] = useState(0)

  const pendingRef = useRef<{
    path: string
    pointerId: number
    startX: number
    startY: number
    el: HTMLElement
  } | null>(null)
  const dragStateRef = useRef<{
    path: string
    pointerId: number
    insertIndex: number
  } | null>(null)
  const windowHandlersRef = useRef<{
    move: (event: PointerEvent) => void
    up: (event: PointerEvent) => void
    cancel: () => void
  } | null>(null)
  const openTabsRef = useRef(props.openTabs)
  openTabsRef.current = props.openTabs
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [insertLineX, setInsertLineX] = useState<number | null>(null)

  // 同步标签容器的横向滚动量，驱动自定义滚动条滑块；窗口/标签变化时重算。
  useEffect(() => {
    const el = tabsScrollRef.current
    if (el === null) return
    const update = (): void => {
      const { scrollLeft, scrollWidth, clientWidth } = el
      const overflow = scrollWidth - clientWidth
      setCanScroll(overflow > 0)
      setThumbRatio(Math.min(1, clientWidth / scrollWidth))
      setScrollRatio(overflow > 0 ? scrollLeft / overflow : 0)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)
    const trackObserver = trackRef.current
      ? new ResizeObserver(() => {
          const width = trackRef.current?.clientWidth ?? 0
          setTrackWidth(width)
        })
      : null
    if (trackObserver !== null)
      trackObserver.observe(trackRef.current as HTMLElement)
    return () => {
      el.removeEventListener('scroll', update)
      observer.disconnect()
      trackObserver?.disconnect()
    }
  }, [props.openTabs])

  // 点击轨道：跳到点击位置附近；拖动滑块：按比例换算 scrollLeft。
  const handleTrackPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
  ): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const el = tabsScrollRef.current
    const track = trackRef.current
    if (el === null || track === null) return
    const trackWidth = track.clientWidth
    const thumbWidth = Math.max(24, trackWidth * thumbRatio)
    const maxScroll = el.scrollWidth - el.clientWidth
    const clickOffset = event.clientX - track.getBoundingClientRect().left
    const startLeft = el.scrollLeft
    const startX = event.clientX

    const onThumb = clickOffset >= 0 && clickOffset <= thumbWidth
    if (!onThumb && maxScroll > 0) {
      el.scrollLeft = (clickOffset / trackWidth) * maxScroll
    }

    const move = (moveEvent: PointerEvent): void => {
      if (maxScroll <= 0) return
      const deltaX = moveEvent.clientX - startX
      const maxDelta = trackWidth - thumbWidth
      const ratio = maxDelta > 0 ? deltaX / maxDelta : 0
      el.scrollLeft = Math.min(
        maxScroll,
        Math.max(0, startLeft + ratio * maxScroll),
      )
    }
    const up = (): void => {
      track.removeEventListener('pointermove', move)
      track.removeEventListener('pointerup', up)
      track.removeEventListener('pointercancel', up)
    }
    track.setPointerCapture(event.pointerId)
    track.addEventListener('pointermove', move)
    track.addEventListener('pointerup', up)
    track.addEventListener('pointercancel', up)
  }

  // 鼠标滚轮在标签栏上滚动时转换为横向滚动；按住 Shift 或已有横向
  // 增量（触控板）时不拦截，保留原生行为。
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (event.shiftKey || event.deltaX !== 0) return
    const el = tabsScrollRef.current
    if (el === null) return
    el.scrollLeft += event.deltaY
  }

  // 指针 x 对应的插入点：候选标签中心左侧即插入其前；lineX 为插入指示
  // 线位置（渲染 + 边缘自动滚动共用）。
  const computeDrop = (
    x: number,
    path: string,
  ): { index: number; lineX: number } => {
    const el = tabsScrollRef.current
    if (el === null) return { index: 0, lineX: 0 }
    const rest = openTabsRef.current.filter((tab) => tab.path !== path)
    const nodes = rest.map((tab) =>
      el.querySelector<HTMLElement>(`[data-tab-path="${cssEscape(tab.path)}"]`),
    )
    let insertAt = rest.length
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]
      if (node === null) continue
      const rect = node.getBoundingClientRect()
      if (x < rect.left + rect.width / 2) {
        insertAt = i
        break
      }
    }
    let lineX = 0
    if (insertAt === 0) {
      lineX = nodes[0]?.offsetLeft ?? 0
    } else if (insertAt >= rest.length) {
      const last = nodes[nodes.length - 1]
      lineX = last !== null ? last.offsetLeft + last.offsetWidth : 0
    } else {
      const prev = nodes[insertAt - 1]
      const next = nodes[insertAt]
      lineX =
        prev !== null && next !== null
          ? (prev.offsetLeft + prev.offsetWidth + next.offsetLeft) / 2
          : 0
    }
    return { index: insertAt, lineX }
  }

  // 按最终插入点落定新顺序；与当前顺序一致时不触发回调。
  const commitDrag = (path: string, insertIndex: number): void => {
    const tabs = openTabsRef.current
    const moved = tabs.find((tab) => tab.path === path)
    if (moved === undefined) return
    const next = tabs.filter((tab) => tab.path !== path)
    next.splice(insertIndex, 0, moved)
    const unchanged =
      next.length === tabs.length &&
      next.every((tab, index) => tab.path === tabs[index].path)
    if (!unchanged) props.onReorderTabs(next.map((tab) => tab.path))
  }

  const clearDragHandlers = useCallback((): void => {
    const handlers = windowHandlersRef.current
    if (handlers !== null) {
      window.removeEventListener('pointermove', handlers.move)
      window.removeEventListener('pointerup', handlers.up)
      window.removeEventListener('pointercancel', handlers.cancel)
      windowHandlersRef.current = null
    }
    pendingRef.current = null
    dragStateRef.current = null
    setDragPath(null)
    setInsertLineX(null)
  }, [])

  // 面板卸载时兜底清理窗口级监听，避免拖拽中途卸载导致泄漏。
  useEffect(() => clearDragHandlers, [clearDragHandlers])

  const handleTabPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    path: string,
  ): void => {
    // 上次按下若未正常结束（如指针在窗口外松开）会残留候选状态，
    // 先自愈清理再登记本次按下，避免标签永久无法拖拽。
    if (windowHandlersRef.current !== null) clearDragHandlers()
    if (event.button !== 0) return
    const el = event.currentTarget

    const move = (moveEvent: PointerEvent): void => {
      const pending = pendingRef.current
      if (pending === null || moveEvent.pointerId !== pending.pointerId) return
      // 主键已松开却仍收到 move（窗口外松开等）时放弃本次拖拽。
      if ((moveEvent.buttons & 1) === 0) {
        clearDragHandlers()
        return
      }
      if (dragStateRef.current === null) {
        // 移动超过阈值才算拖拽，避免点击时的轻微抖动误触发。
        const dx = moveEvent.clientX - pending.startX
        const dy = moveEvent.clientY - pending.startY
        if (Math.hypot(dx, dy) < 5) return
        moveEvent.preventDefault()
        dragStateRef.current = {
          path: pending.path,
          pointerId: pending.pointerId,
          insertIndex: 0,
        }
        setDragPath(pending.path)
        pending.el.setPointerCapture(pending.pointerId)
      }
      const drop = computeDrop(moveEvent.clientX, pending.path)
      if (dragStateRef.current !== null) {
        dragStateRef.current.insertIndex = drop.index
      }
      setInsertLineX(drop.lineX)
      // 拖到标签行边缘时自动滚动，保证指示线始终可见。
      const scroller = tabsScrollRef.current
      if (scroller !== null && scroller.scrollWidth > scroller.clientWidth) {
        if (drop.lineX < scroller.scrollLeft + 4) {
          scroller.scrollLeft = Math.max(0, drop.lineX - 4)
        } else if (
          drop.lineX >
          scroller.scrollLeft + scroller.clientWidth - 4
        ) {
          scroller.scrollLeft = drop.lineX - scroller.clientWidth + 4
        }
      }
    }

    const up = (upEvent: PointerEvent): void => {
      const pending = pendingRef.current
      const engaged = dragStateRef.current
      if (
        engaged !== null &&
        pending !== null &&
        upEvent.pointerId === engaged.pointerId
      ) {
        commitDrag(engaged.path, engaged.insertIndex)
      }
      clearDragHandlers()
    }

    const cancel = (): void => {
      clearDragHandlers()
    }

    pendingRef.current = {
      path,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      el,
    }
    windowHandlersRef.current = { move, up, cancel }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  return (
    <div className="file-tabs" role="tablist" aria-label="已打开文件">
      <div
        className="file-tabs-scroll"
        ref={tabsScrollRef}
        onWheel={handleWheel}
      >
        {dragPath !== null && insertLineX !== null && (
          <div
            className="file-tabs-drop-line"
            aria-hidden="true"
            style={{ transform: `translateX(${insertLineX}px)` }}
          />
        )}
        {props.openTabs.map((tab) => {
          const active = tab.path === props.activePath
          const dragging = tab.path === dragPath
          const dirty = props.dirtyPaths.has(tab.path)
          const fileName = tab.path.split('/').pop() ?? tab.path
          return (
            <div
              key={tab.path}
              data-tab-path={tab.path}
              className={`file-tab${active ? ' active' : ''}${
                dragging ? ' dragging' : ''
              }${dirty ? ' dirty' : ''}`}
              role="tab"
              aria-selected={active}
              onPointerDown={(event) => handleTabPointerDown(event, tab.path)}
            >
              <button
                type="button"
                className="file-tab-main"
                title={tab.path}
                onClick={() => props.onSelectTab(tab.path)}
              >
                {fileName}
              </button>
              {dirty && <span className="file-tab-dirty" aria-hidden="true" />}
              <button
                type="button"
                className="file-tab-close"
                title={`关闭 ${fileName}`}
                aria-label={`关闭 ${fileName}`}
                onClick={() => props.onCloseTab(tab.path)}
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
      {/* 始终可见的自定义横向滚动条：有溢出才显示滑块，可点击/拖动 */}
      <div
        className="file-tabs-track"
        ref={trackRef}
        onPointerDown={handleTrackPointerDown}
      >
        {canScroll && trackWidth > 0 && (
          <div
            className="file-tabs-thumb"
            style={{
              width: `${Math.max(24, trackWidth * thumbRatio)}px`,
              transform: `translateX(${scrollRatio * Math.max(0, trackWidth - 8 - Math.max(24, trackWidth * thumbRatio))}px)`,
            }}
          />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: FileViewerPanel 换用 FileTabs**

FileViewerPanel 中删除已迁出的全部实现（cssEscape、tabs/track refs、滚动同步 effect、handleTrackPointerDown、handleWheel、computeDrop、commitDrag、clearDragHandlers、卸载 effect、handleTabPointerDown、拖拽 state），标签区 JSX 替换为：

```tsx
      {props.openTabs.length > 0 ? (
        <FileTabs
          openTabs={props.openTabs}
          activePath={props.activePath}
          dirtyPaths={props.dirtyPaths}
          onSelectTab={props.onSelectTab}
          onCloseTab={props.onCloseTab}
          onReorderTabs={props.onReorderTabs}
        />
      ) : (
```

（`dirtyPaths` prop 与 `onCloseTab→onRequestCloseTab` 改名在 Task 9 一并处理；本步先给 FileViewerPanel 临时加 `dirtyPaths: Set<string>` prop 并在 App 传空集？——**不要**：本步直接同时给 FileViewerPanel 加 `dirtyPaths` prop 声明，App 调用处暂不传，TS 会报错；因此本步连同 App 调用处一起加 `dirtyPaths={dirtyPaths}`（App 在 Task 3 之后已可解构出 dirtyPaths）。App 的其他接线仍留 Task 10。）

即：本步同步修改 `App.tsx` 的 `<FileViewerPanel …>` 增加 `dirtyPaths={dirtyPaths}`，并在 App 的 useWorkspacePanel 解构中加入 `dirtyPaths`。

- [ ] **Step 3: 标签条样式重构（workspace.css）+ 编辑器底色变量**

`styles/style.css` 的 `:root` 增加：

```css
/* Monaco/内容区背景：active 标签与之融合（VS Code 风格）。 */
--bg-editor: #1e1e1e;
```

`workspace.css` 中「右侧多文件标签」段替换为：

```css
/* ---------- 右侧多文件标签 ---------- */

.file-tabs {
  flex: none;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 4px 6px 0;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-sidebar);
}

.file-tabs-scroll {
  position: relative;
  display: flex;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  /* 隐藏原生滚动条，改用下方自定义可见滑块 */
  scrollbar-width: none;
  overscroll-behavior-x: contain;
  /* 标签文字不可选中，避免拖拽排序时被文本选择干扰 */
  user-select: none;
  -webkit-user-select: none;
}

.file-tabs-scroll::-webkit-scrollbar {
  display: none;
}

.file-tabs-scroll:focus-visible {
  outline: 1px solid var(--border);
}

/* 拖拽排序的插入指示线：随指针移动实时预览落点 */
.file-tabs-drop-line {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 1;
  width: 2px;
  background: var(--info);
  pointer-events: none;
}

/* 自定义横向滚动条：始终在标签行下方占位，有溢出才显示滑块 */
.file-tabs-track {
  position: relative;
  height: 6px;
  flex: none;
  padding: 1px 4px;
  background: var(--bg-inset);
  border-top: 1px solid var(--border-subtle);
  cursor: pointer;
}

.file-tabs-thumb {
  position: absolute;
  top: 1px;
  left: 4px;
  height: 4px;
  border-radius: 3px;
  background: var(--bg-active);
  cursor: grab;
}

.file-tabs-thumb:active {
  cursor: grabbing;
  background: var(--text-muted);
}

/* VS Code 风格标签：无竖向分隔，active 融入内容区（底边上移盖住
   标签条边框 + 同色背景），顶部圆角。 */
.file-tab {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  max-width: 210px;
  color: var(--text-muted);
  cursor: grab;
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 8px 8px 0 0;
}

.file-tab:active {
  cursor: grabbing;
}

.file-tab:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.file-tab.dragging {
  opacity: 0.5;
  background: var(--bg-active);
  outline: 1px dashed var(--text-muted);
  outline-offset: -1px;
}

.file-tab.active {
  color: var(--text);
  background: var(--bg-editor);
  border-color: var(--border-subtle);
  margin-bottom: -1px;
}

.file-tab-main {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 7px 8px;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font-size: 12px;
}

.file-tab-main:hover {
  background: transparent;
}

.file-tab-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 3px 7px;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  line-height: 1;
}

.file-tab-close:hover {
  background: var(--bg-hover);
  color: var(--text);
}

/* 脏圆点替代关闭 ×；hover 标签时圆点变回 ×。 */
.file-tab-dirty {
  flex: none;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--warning-text);
}

.file-tab.dirty .file-tab-close {
  display: none;
}

.file-tab.dirty:hover .file-tab-close {
  display: inline-flex;
}

.file-tab.dirty:hover .file-tab-dirty {
  display: none;
}
```

- [ ] **Step 4: 编辑器头部样式（workspace.css，配合 Task 5 的新结构）**

`.content-head` 区域调整为：

```css
.content-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-subtle);
}

.content-head-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.content-head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.content-dirty-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warning-text);
}

.content-close {
  padding: 2px 8px;
  font-size: 16px;
  line-height: 1.2;
}
```

（删除原 `.content-name { flex: 1; … }` 的 flex:1——现由 `.content-head-main` 承担，`.content-name` 保留 ellipsis 三行。删除原 `.content-head .ghost` / `.content-head .ghost.active` 的 flex:none 覆盖（actions 自身 flex:none）。）

- [ ] **Step 5: 验证**

Run: `pnpm --filter @reflexion-os-studio/desktop typecheck && pnpm lint && npx prettier --write apps/desktop/frontend/features/workspace/FileTabs.tsx apps/desktop/frontend/features/workspace/FileViewerPanel.tsx apps/desktop/frontend/features/workspace/workspace.css`

---

### Task 9: FileViewerPanel — 保活 + 句柄聚合 + 关闭守卫接线

**Files:**

- Modify: `apps/desktop/frontend/features/workspace/FileViewerPanel.tsx`（结构性重写）

- [ ] **Step 1: 完整重写 FileViewerPanel.tsx**

```tsx
import { useCallback, useImperativeHandle, useRef } from 'react'
import type { Ref } from 'react'
import type { Project, ResourceLink } from '@reflexion-os-studio/runtime-client'
import { FolderIcon } from '../../ui/icons'
import { ContentView } from './ContentView'
import { DiffViewer } from './DiffViewer'
import { FileTabs } from './FileTabs'
import { MarkdownFilePreview } from './preview/MarkdownFilePreview'
import { BinaryFilePreview } from './preview/BinaryFilePreview'
import { getPreviewKind } from './preview/preview'
import type { MonacoSurfaceHandle } from './editor/MonacoSurface'
import type { OpenFileTab } from './types'

/** surface 句柄 getter：调用时解引用，规避 useImperativeHandle 重建导致的陈旧闭包。 */
type SurfaceGetter = () => MonacoSurfaceHandle | null

export interface FileViewerPanelHandle {
  /** 保存指定文件；句柄缺失（非文本标签/未挂载）或保存失败返回 false。 */
  saveDirty: (path: string) => Promise<boolean>
  /** 逐个保存所有脏文件，返回成功/失败清单（全部尝试，不提前终止）。 */
  saveAllDirty: () => Promise<{ saved: string[]; failed: string[] }>
}

interface FileViewerPanelProps {
  /** 当前激活项目；null 时展示占位提示。 */
  project: Project | null
  /** Rust System Runtime 可用性：文件读取依赖它。 */
  systemReady: boolean
  /** 已打开的标签（有序，前端保证不重复）。 */
  openTabs: OpenFileTab[]
  /** 当前激活标签的 path；null 表示无激活文件。 */
  activePath: string | null
  /** 已修改未保存的文件路径集合。 */
  dirtyPaths: Set<string>
  onSelectTab: (path: string) => void
  /** 关闭请求：经 App 层守卫（脏文件弹确认）后才真正 closeTab。 */
  onRequestCloseTab: (path: string) => void
  /** 拖拽排序完成后回调：paths 为新的打开顺序。 */
  onReorderTabs: (paths: string[]) => void
  /** 编辑内核脏状态上抛（App 存入 dirtyPaths）。 */
  onDirtyChange: (path: string, dirty: boolean) => void
  /** Markdown 源码→预览切换守卫用的应用级确认弹窗。 */
  confirm: (state: {
    title: string
    message: string
    confirmLabel?: string
    danger?: boolean
  }) => Promise<boolean>
  /** 面板宽度（由 App 拖拽控制）。 */
  width?: number
  /** Markdown 预览内资源引用（相对路径 / workspace:// / asset://）分发。 */
  onResourceClick?: (link: ResourceLink) => void
  /** React 19 ref-as-prop：保存命令句柄（快捷键/守卫流程用）。 */
  ref?: Ref<FileViewerPanelHandle>
}

/**
 * 对话右侧的文件查看器：多文件标签 + 内容区。文本类标签（Monaco /
 * Markdown 预览）**保活**：全部保持挂载、非激活 display:none 隐藏，
 * 未保存内容跨标签切换存活（修复此前切换即卸载导致修改丢失的缺陷），
 * 后台脏标签也可经句柄保存。diff / binary 标签无脏状态，维持仅渲染
 * 激活项。关闭一律走 onRequestCloseTab（App 层守卫）。
 */
export function FileViewerPanel(
  props: FileViewerPanelProps,
): React.JSX.Element {
  const { project } = props
  const activeTab =
    props.openTabs.find((tab) => tab.path === props.activePath) ?? null

  const surfaceGettersRef = useRef(new Map<string, SurfaceGetter>())

  const registerSurface = useCallback(
    (path: string, getter: SurfaceGetter | null): void => {
      if (getter === null) surfaceGettersRef.current.delete(path)
      else surfaceGettersRef.current.set(path, getter)
    },
    [],
  )

  const saveDirty = useCallback(async (path: string): Promise<boolean> => {
    const getter = surfaceGettersRef.current.get(path)
    const handle = getter?.() ?? null
    if (handle === null) return false
    return handle.save()
  }, [])

  const saveAllDirty = useCallback(async (): Promise<{
    saved: string[]
    failed: string[]
  }> => {
    const saved: string[] = []
    const failed: string[] = []
    for (const path of props.dirtyPaths) {
      if (await saveDirty(path)) saved.push(path)
      else failed.push(path)
    }
    return { saved, failed }
  }, [props.dirtyPaths, saveDirty])

  useImperativeHandle(props.ref, () => ({ saveDirty, saveAllDirty }), [
    saveDirty,
    saveAllDirty,
  ])

  if (project === null) {
    return (
      <div className="workspace-panel" style={{ width: props.width }}>
        <div className="workspace-panel-empty">
          <FolderIcon />
          <p>在左侧选择项目后，可在这里浏览工作区文件。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="workspace-panel" style={{ width: props.width }}>
      {props.openTabs.length > 0 ? (
        <FileTabs
          openTabs={props.openTabs}
          activePath={props.activePath}
          dirtyPaths={props.dirtyPaths}
          onSelectTab={props.onSelectTab}
          onCloseTab={props.onRequestCloseTab}
          onReorderTabs={props.onReorderTabs}
        />
      ) : (
        <div className="workspace-panel-empty">
          <FolderIcon />
          <p>在左侧项目文件工作区中选择文件，可在右侧打开预览。</p>
        </div>
      )}

      {!props.systemReady && activeTab !== null && (
        <div className="workspace-degraded">
          工具 Runtime 不可用：文件预览暂不可用。
        </div>
      )}

      {props.openTabs.map((tab) => {
        if (tab.mode === 'diff') return null
        const kind = getPreviewKind(tab.path)
        if (kind === 'binary') return null
        const active = tab.path === props.activePath
        return (
          <div
            key={tab.path}
            className="workspace-tab-page"
            style={{ display: active ? 'flex' : 'none' }}
          >
            {kind === 'markdown' ? (
              <MarkdownFilePreview
                projectId={project.id}
                path={tab.path}
                onResourceClick={props.onResourceClick}
                onDirtyChange={props.onDirtyChange}
                registerSurface={registerSurface}
                confirm={props.confirm}
              />
            ) : (
              <ContentView
                projectId={project.id}
                path={tab.path}
                initialLine={tab.line}
                readOnly={false}
                onClose={() => props.onRequestCloseTab(tab.path)}
                onDirtyChange={props.onDirtyChange}
                registerSurface={registerSurface}
              />
            )}
          </div>
        )
      })}

      {activeTab?.mode === 'diff' && (
        <DiffViewer
          key={`${activeTab.path}#diff`}
          projectId={project.id}
          path={activeTab.path}
          staged={activeTab.staged}
          oldPath={activeTab.oldPath}
          source={activeTab.source}
          before={activeTab.before}
          after={activeTab.after}
          onClose={() => props.onRequestCloseTab(activeTab.path)}
        />
      )}

      {activeTab !== null &&
        activeTab.mode !== 'diff' &&
        getPreviewKind(activeTab.path) === 'binary' && (
          <BinaryFilePreview key={activeTab.path} path={activeTab.path} />
        )}
    </div>
  )
}
```

注意：`confirm` prop 的类型用结构化类型（与 `ConfirmDialogState` 兼容的子集）避免组件层 import hook 类型；App 传 `confirm` 时天然满足。

- [ ] **Step 2: 新增页面容器样式（workspace.css）**

```css
/* 保活的非激活文本标签页容器：display:none 隐藏，激活时 flex 铺满。 */
.workspace-tab-page {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
```

- [ ] **Step 3: 验证**

Run: `pnpm --filter @reflexion-os-studio/desktop typecheck`
Expected: App.tsx 报 props 不匹配错误（onCloseTab→onRequestCloseTab、新增必填 props、ref）——**这是预期**，Task 10 修复 App 后消除。

---

### Task 10: App 接线 — 守卫 hook + 热键 + 导航异步化 + 关窗口拦截

**Files:**

- Create: `apps/desktop/frontend/hooks/useWorkspaceTabGuard.ts`
- Create: `apps/desktop/frontend/hooks/useAppHotkeys.ts`
- Modify: `apps/desktop/frontend/hooks/useSessionNavigation.ts`
- Modify: `apps/desktop/frontend/App.tsx`
- Modify: `apps/desktop/src-tauri/capabilities/default.json`

- [ ] **Step 1: 新建 useWorkspaceTabGuard.ts**

```ts
import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { FileViewerPanelHandle } from '../features/workspace/FileViewerPanel'
import type { ConfirmResult } from './useConfirmDialog'

interface ConfirmInput {
  title: string
  message: string
  confirmLabel?: string
  tertiaryLabel?: string
  danger?: boolean
}

interface WorkspaceTabGuardDeps {
  dirtyPaths: Set<string>
  closeTab: (path: string) => void
  resetWorkspaceFiles: () => void
  confirmAction: (state: ConfirmInput) => Promise<ConfirmResult>
  setNotice: (message: string) => void
  filePanelRef: RefObject<FileViewerPanelHandle | null>
}

export interface WorkspaceTabGuard {
  /** 关闭标签请求：脏文件先弹三键确认（保存并关闭/不保存/取消）。 */
  requestCloseTab: (path: string) => Promise<void>
  /** 切项目/会话前的清空守卫：返回 false 表示用户取消切换。 */
  guardedResetWorkspaceFiles: () => Promise<boolean>
}

/**
 * 文件标签关闭/切换守卫：脏文件的三类数据丢失口子（关标签、切项目、
 * 关窗口）统一在此编排确认弹窗；deps 经 latest-ref 读取，回调身份稳定。
 */
export function useWorkspaceTabGuard(
  deps: WorkspaceTabGuardDeps,
): WorkspaceTabGuard {
  const latest = useRef(deps)
  latest.current = deps

  const requestCloseTab = useCallback(async (path: string): Promise<void> => {
    const { dirtyPaths, closeTab, confirmAction, setNotice, filePanelRef } =
      latest.current
    if (!dirtyPaths.has(path)) {
      closeTab(path)
      return
    }
    const fileName = path.split('/').pop() ?? path
    const result = await confirmAction({
      title: '有未保存的修改',
      message: `${fileName} 有未保存的修改，关闭后将丢失。`,
      confirmLabel: '保存并关闭',
      tertiaryLabel: '不保存',
    })
    if (result === 'cancel') return
    if (result === 'confirm') {
      const ok = (await filePanelRef.current?.saveDirty(path)) ?? false
      if (!ok) {
        setNotice('保存失败，已保留标签页；请在编辑器中查看错误。')
        return
      }
    }
    closeTab(path)
  }, [])

  const guardedResetWorkspaceFiles = useCallback(async (): Promise<boolean> => {
    const {
      dirtyPaths,
      resetWorkspaceFiles,
      confirmAction,
      setNotice,
      filePanelRef,
    } = latest.current
    if (dirtyPaths.size === 0) {
      resetWorkspaceFiles()
      return true
    }
    const result = await confirmAction({
      title: '有未保存的修改',
      message: `切换项目将关闭 ${dirtyPaths.size} 个已修改文件，未保存的修改将丢失。`,
      confirmLabel: '保存全部并切换',
      tertiaryLabel: '放弃修改并切换',
    })
    if (result === 'cancel') return false
    if (result === 'confirm') {
      const { failed } = (await filePanelRef.current?.saveAllDirty()) ?? {
        saved: [],
        failed: ['（文件句柄不可用）'],
      }
      if (failed.length > 0) {
        setNotice(`保存失败：${failed.join('、')}，已取消切换。`)
        return false
      }
    }
    resetWorkspaceFiles()
    return true
  }, [])

  // 关窗口拦截：脏文件存在时阻止默认关闭，弹窗确认后 destroy。
  // 挂载时接线一次，回调经 latest-ref 读当轮闭包（性能纪律）。
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        const { dirtyPaths, confirmAction } = latest.current
        if (dirtyPaths.size === 0) return
        event.preventDefault()
        const result = await confirmAction({
          title: '有未保存的修改',
          message: `有 ${dirtyPaths.size} 个文件未保存，退出后将丢失。`,
          confirmLabel: '放弃修改并退出',
          danger: true,
        })
        if (result === 'cancel') return
        await getCurrentWindow().destroy()
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return { requestCloseTab, guardedResetWorkspaceFiles }
}
```

- [ ] **Step 2: 新建 useAppHotkeys.ts**

```ts
import { useEffect, useRef } from 'react'
import { IS_MAC } from '../lib/platform'

export interface AppHotkeyHandlers {
  saveActive: () => void
  closeActiveTab: () => void
}

/**
 * 应用级快捷键（编辑器外兜底；编辑器内 Cmd/Ctrl+S 由 Monaco addCommand
 * 处理，其 keydown 不再冒泡到此处）：保存 Cmd/Ctrl+S；关标签
 * macOS Cmd+Shift+W（Cmd+W 被系统"关闭窗口"菜单占用）/ 其他平台 Ctrl+W。
 * 挂载时接线一次，回调经 latest-ref 读取（性能纪律）。
 */
export function useAppHotkeys(handlers: AppHotkeyHandlers): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = IS_MAC ? event.metaKey : event.ctrlKey
      if (!mod) return
      const key = event.key.toLowerCase()
      if (key === 's') {
        event.preventDefault()
        handlersRef.current.saveActive()
        return
      }
      if (key === 'w') {
        if (IS_MAC && !event.shiftKey) return
        event.preventDefault()
        handlersRef.current.closeActiveTab()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
```

- [ ] **Step 3: useSessionNavigation 异步化清空守卫**

`SessionNavigationDeps.resetWorkspaceFiles` 类型改为：

```ts
/** 确认并清空工作区文件（可能弹窗）；返回 false 表示用户取消切换。 */
resetWorkspaceFiles: () => boolean | Promise<boolean>
```

三个调用点异步化：

```ts
const selectProject = (projectId: string): void => {
  void (async () => {
    if (!(await deps.resetWorkspaceFiles())) return
    deps.setActiveProjectId(projectId)
    deps.setActiveSessionId(null)
    deps.setSessionData(null)
    deps.setDelegations([])
    deps.setView('chat')
    void deps.refreshProjectSessions(projectId)
  })()
}

const selectLandingProject = (projectId: string | null): void => {
  void (async () => {
    deps.setActiveProjectId(projectId)
    deps.setActiveSessionId(null)
    deps.setSessionData(null)
    deps.setDelegations([])
    if (projectId !== null) {
      if (!(await deps.resetWorkspaceFiles())) return
      void deps.refreshProjectSessions(projectId)
    }
  })()
}
```

（注意 `selectLandingProject` 语义：确认弹窗期间 `activeProjectId` 已变——原实现同样是先 set 后 reset，行为顺序保持一致；弹窗取消时工作区标签保留、仅项目上下文已切换，与现状一致，不额外回滚。）

```ts
const enterProjectFiles = (projectId: string): void => {
  void (async () => {
    const switching = deps.activeProjectId !== projectId
    if (switching && !(await deps.resetWorkspaceFiles())) return
    deps.setActiveProjectId(projectId)
    deps.setView('chat')
    deps.setSidebarMode('files')
    deps.setSidebarOpen(true)
    void deps.refreshProjectSessions(projectId)
  })()
}
```

- [ ] **Step 4: App.tsx 接线**

a) imports 增加：

```ts
import { useRef } from 'react' // 若已 import useRef 则并入现有 import
import {
  FileViewerPanel,
  type FileViewerPanelHandle,
} from './features/workspace/FileViewerPanel' // 替换现有 FileViewerPanel import
import { useWorkspaceTabGuard } from './hooks/useWorkspaceTabGuard'
import { useAppHotkeys } from './hooks/useAppHotkeys'
```

b) `useConfirmDialog()` 解构改为：

```ts
const {
  confirmState,
  confirm,
  confirmAction,
  handleConfirm,
  handleTertiary,
  handleCancel,
} = useConfirmDialog()
```

c) `useWorkspacePanel()` 解构增加 `dirtyPaths, setTabDirty`。

d) 在 `useSessionNavigation(...)` 之前插入（filePanelRef 需在此之前声明）：

```ts
const filePanelRef = useRef<FileViewerPanelHandle>(null)
const { requestCloseTab, guardedResetWorkspaceFiles } = useWorkspaceTabGuard({
  dirtyPaths,
  closeTab,
  resetWorkspaceFiles,
  confirmAction,
  setNotice,
  filePanelRef,
})
useAppHotkeys({
  saveActive: () => {
    if (activeFilePath === null || !dirtyPaths.has(activeFilePath)) return
    void filePanelRef.current?.saveDirty(activeFilePath)
  },
  closeActiveTab: () => {
    if (activeFilePath !== null) void requestCloseTab(activeFilePath)
  },
})
```

（`setNotice` 为 App 内既有状态 setter；`activeFilePath`/`closeTab`/`resetWorkspaceFiles` 来自 useWorkspacePanel 解构。）

e) `useSessionNavigation` deps 中 `resetWorkspaceFiles,` 改为 `resetWorkspaceFiles: guardedResetWorkspaceFiles,`。

f) `<FileViewerPanel …>` props 更新：

```tsx
<FileViewerPanel
  ref={filePanelRef}
  project={activeProject}
  systemReady={bootstrap?.systemReady ?? false}
  openTabs={openTabs}
  activePath={activeFilePath}
  dirtyPaths={dirtyPaths}
  onSelectTab={selectTab}
  onRequestCloseTab={requestCloseTab}
  onReorderTabs={reorderTabs}
  onDirtyChange={setTabDirty}
  confirm={confirm}
  onResourceClick={handleResourceClick}
  width={workspaceWidth}
/>
```

（Task 8 步骤 2 已临时加过 `dirtyPaths={dirtyPaths}`，此处合并为最终形态。）

g) `<ConfirmDialog …>` 增加 `onTertiary={handleTertiary}`。

- [ ] **Step 5: capabilities 放行窗口关闭**

`apps/desktop/src-tauri/capabilities/default.json` 的 permissions 增加：

```json
    "core:default",
    "core:window:allow-close",
    "core:window:allow-destroy",
    "dialog:allow-open",
    "clipboard-manager:allow-write-text"
```

- [ ] **Step 6: 验证**

Run: `pnpm --filter @reflexion-os-studio/desktop typecheck && pnpm lint && cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: 全部通过

- [ ] **Step 7: 行数纪律检查**

Run: `wc -l apps/desktop/frontend/App.tsx apps/desktop/frontend/features/workspace/FileViewerPanel.tsx apps/desktop/frontend/features/workspace/FileTabs.tsx`
Expected: 各文件 ≤500；FileViewerPanel 应已大幅低于 454；App 若仍 >500，把顶层布局分支（LandingView/ChatView 选择段落）拆为 `AppMain.tsx` 再复检——若需要此步，保持纯移动不改逻辑。

---

### Task 11: 全量验证与修正

- [ ] **Step 1: 全量验证流程**

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @reflexion-os-studio/desktop typecheck
pnpm build:packages
cargo fmt --manifest-path crates/Cargo.toml -- --check
cargo test --manifest-path crates/Cargo.toml
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

任何失败即修（只修本计划引入的问题；预先存在的失败如实记录并跳过）。

- [ ] **Step 2: 改动文件针对性格式化**

```bash
git status --short | awk '{print $2}' | grep -E '\.(tsx?|css)$' | xargs npx prettier --write --no-ignore
pnpm format:check
```

- [ ] **Step 3: 交付说明**

汇报：通过项、跳过项、已知限制（性能采样与三平台手测需 dev 模式人工执行，列清单给用户）。

---

## Self-Review 记录

- **Spec 覆盖**：列宽（T1）、ConfirmDialog 三键（T2）、脏状态上收（T3）、Cmd+S（T4/T10）、脏链路+句柄（T5/T6/T7）、标签保活+圆点+VS Code 风格（T8/T9）、关闭/切项目/关窗口拦截（T9/T10）、热键（T10）、拆分纪律（T8/T9/Task10-Step7）、验证（T11）——全覆盖。
- **占位符**：T7 Step 3 的 eslint-disable 示例已标注"禁止，除非无法消除"，并以替代方案为准。
- **类型一致性**：`MonacoSurfaceHandle.save(): Promise<boolean>`（T4 定义，T9 消费）；`ConfirmResult`（T2 定义，T10 消费）；`FileViewerPanelHandle`（T9 定义，T10 消费）；`SurfaceGetter`（T9 定义，T5/T6/T7 的 registerSurface 签名匹配）；`registerSurface(path, getter|null)` 各处一致。
- **已知取舍**：`selectLandingProject` 弹窗取消时不回滚项目上下文切换（与原实现顺序一致，标签保留）；`enterProjectFiles` 在弹窗期间不切换 sidebar（新增的守卫语义）。

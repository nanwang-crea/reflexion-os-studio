## 目标
优化设置页，解决“挤、丑”问题。融合 zcode 的分区导航结构与 ChatGPT 桌面版的疏朗感：保留左侧分类导航便于定位，但内容列收窄居中、加大留白、Agent 面板内部分组、修复窄屏折行、统一激活态。不改任何业务功能与协议。

## 改动范围（纯 UI）

### 1. 内容列收窄居中（ChatGPT 式呼吸感）
- 新增 `.settings-single` 包装容器：把 **Agent 运行时** 与 **MCP** 两个单列面板居中、限宽约 `740px`，左右留白充足，避免贴满整屏。
- 保持 **模型供应商** 用宽版双栏卡片（需要列表+详情两栏宽度），不受限宽影响。
- SettingsView 中给 runtime / mcp 包上 `.settings-single`。

### 2. MCP 面板升级为正式卡片
- `.mcp-panel` 从当前“顶部加线的小节”改为与 `.agent-runtime` 一致的卡片：统一 surface 背景、边框、`16px` 圆角、柔和阴影、内边距。
- 移除旧的 `.settings-content .mcp-panel { border-top:none; padding-top:0 }` 覆盖，保证卡片 padding 生效。

### 3. Agent 运行时面板分组
- 把 9 个字段按主题分组，各带小组小标题 + 细分隔线：
  - 「循环」：最大轮次、反思阈值
  - 「网络」：请求重试、请求超时
  - 「子 Agent 委派」：深度、数量、并行、超时、token 上限
- 新增 `.runtime-group-title` 与分隔样式；小组标题沿用 `.settings-eyebrow` 的强调色语言。
- `.delegation-note`（子 Agent 复用父 Provider 提示）保留在委派组顶部。

### 4. 统一导航激活态与间距
- `.settings-nav-item.active` 从“半透明 + 左侧 inset 指示条”改为与主侧栏一致的实底激活态（`--bg-elevated`/`--bg-active`），去色块、更干净。
- 统一面板内边距到约 `28px`，加大分组间距，微调 hint 行高与颜色层级，减少视觉拥挤。

### 5. 窄屏响应式修复
- `.mcp-add`（当前 `1fr 1fr 2fr auto` 四列）增加媒体查询：窄屏退化为纵向堆叠，避免输入框被压扁。
- Agent 分组网格沿用 `auto-fit minmax`，窄屏自然收成单列。
- 导航激活条在窄屏从左侧竖条改为顶部横条（已有逻辑，保留）。

### 6. 验证
- `pnpm --filter @reflexion-os-studio/desktop typecheck`
- `pnpm lint`、`pnpm format:check`
- `pnpm build:packages`
- 说明：纯 CSS/结构改动，不涉及协议与 Runtime；实际视觉等待截图验收时确认。

## 不实现（边界）
- 不改模型供应商单卡的编辑逻辑。
- 不做主题切换、不做透明玻璃质感、不改左/右栏整体宽度。
- 不新增页面路由或路由页。

## 涉及文件
- `apps/desktop/frontend/features/settings/SettingsView.tsx`
- `apps/desktop/frontend/features/settings/AgentRuntimePanel.tsx`
- `apps/desktop/frontend/features/settings/McpPanel.tsx`
- `apps/desktop/frontend/features/settings/settings.css`
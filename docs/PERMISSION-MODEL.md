# Permission Model

Phase 1 采用主流桌面 Agent 的简单模型：**Permission Profile + Chat Approval + Rust 硬边界**。不构建签名 token、密钥轮换或分布式授权系统。

## Profiles

### `read-only`

允许 `file.read`、`file.list`、`file.glob`、`file.grep`，禁止一切写类操作和 Shell。

### `workspace`

允许在当前 Workspace 内读取、搜索（glob/grep）、写入/编辑/删除/移动/建目录和执行 Shell。Shell 的 cwd 必须位于 Workspace；危险命令仍按操作策略请求审批。`workspace` 是默认推荐 Profile。

不提供全局 `full-access` Profile。

### 完全允许（Trusted，权限下拉第三档）

在 `workspace` Profile 之上提供**信任档**（Composer 权限下拉的第三档，随 `message.send` 的 `trusted` 参数下发）：

- 开启后，本次发送的 Run 对 `file.write/edit/delete/move/mkdir` 与 `shell.execute` 自动放行（决策从 `ask` 变为 `automatic`），不再弹出审批卡。
- **Shell 不受工作区边界限制**：文件操作的 workspace 边界由 Rust 强制，但 Shell 执行任意命令无法真正限制在 Workspace 内；下拉选项与 title 必须如实标注该风险。
- 范围与生效：仅对 `workspace` Profile 且有工作区的 Run 生效；`read-only` 优先于 trusted；MCP 工具与未知工具仍走 `ask`；子 Run 工具白名单本就无写/Shell，不受信任档放大。
- 生命周期：trusted 档不持久化（前端内存态），刷新/重启后回落"工作区读写"；排队消息各自携带发送时的 trusted 值（UI 以"信任放行"徽标提示）；`run.retry` 不继承（与 permissionMode 同口径）。
- 凭据语义不变：信任放行的写/Shell 调用仍由 Runtime 签发会话级 grant（grantId 形如 `trusted:<operation>`），Rust 侧 `require_grant` 校验照常生效。

## 操作策略

每种能力使用 `automatic`、`ask`、`denied` 三种策略：

```ts
type DecisionMode = 'automatic' | 'ask' | 'denied'
interface PermissionPolicy {
  fileRead: DecisionMode
  fileWrite: DecisionMode
  shellExecute: DecisionMode
}
```

`ask` 在 Chat 中显示 Approval Card，用户可以 Allow once、Allow for session 或 Deny。一次批准生成一个由 Runtime 管理的短期内存 `ApprovalGrant`：

```ts
interface ApprovalGrant {
  grantId: string
  requestId: string
  workspaceId: string
  operation:
    | 'file.read'
    | 'file.list'
    | 'file.glob'
    | 'file.grep'
    | 'file.write'
    | 'file.edit'
    | 'file.delete'
    | 'file.move'
    | 'file.mkdir'
    | 'shell.execute'
  scope: 'once' | 'session'
  expiresAt: string
}
```

Grant 不是跨机器安全凭证，不写入数据库，不进事件 payload，不需要签名/MAC/nonce。Rust 只接受由已连接 Runtime 建立的 grant 引用，并检查 request、workspace、operation、scope 和过期时间；进程重启后全部失效。

**MVP 落地边界**：grant 语义（once/session 范围、过期）由 Runtime 内存管理（ApprovalGateway）；Rust 侧当前只校验 write/execute 请求携带非空 grant 引用，完整 grant 对象校验（scope/expiry 绑定）随 Phase 6 加固下沉 Rust。Rust 的硬边界（路径规范化/符号链接/体量/超时/树杀）已完整生效。

## 两层职责

### TypeScript Policy Gateway

负责产品层决策：默认是否允许、是否询问用户、审批范围和 UI 状态。它不能让 Rust 执行超出 Rust 硬边界的操作。

### Rust Enforcement

负责不可绕过的底线：deny-by-default、请求 schema、workspace-relative 路径、路径规范化、`..` 拒绝、符号链接边界、Shell cwd、命令超时、环境过滤、输出限制和进程树回收。Rust 不接受任意 `authorized: true`；无效 grant、越界路径、超时或不合法参数直接拒绝。

Phase 1 的 Rust 是应用级执行边界，不承诺跨平台完整 OS Sandbox。Seatbelt、bubblewrap/seccomp、Windows Job Object 等平台级隔离放到 Phase 6。

## Agent 可见能力

Phase 1 Agent Tool：只读类 `file.read`、`file.list`、`file.glob`、`file.grep`；写类 `file.write`、`file.edit`、`file.delete`、`file.move`、`file.mkdir`；执行类 `shell.execute`。另有不依赖 Workspace 的纯工具 `get_current_time`、`web.fetch`（只读网络抓取，无本地副作用，不进入审批维度）。`process.spawn` 是 Rust 内部实现细节，不作为独立 Agent Tool 或独立审批项。

浏览器、网络域名策略、脚本、下载、剪贴板、Asset 导出和系统应用打开不属于 Phase 1A；Phase 1B 仅在需要系统浏览器打开时增加明确的 `resource.open.external`。

## 审计

记录请求来源、operation、workspace、路径/命令摘要、用户决策、grant scope、执行结果和拒绝原因；凭据和完整敏感输入不得进入日志或事件。

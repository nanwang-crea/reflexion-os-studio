# Permission Model

Phase 1 采用主流桌面 Agent 的简单模型：**Permission Profile + Chat Approval + Rust 硬边界**。不构建签名 token、密钥轮换或分布式授权系统。

## Profiles

### `read-only`

允许 `file.read`、`file.list`，禁止写入和 Shell。

### `workspace`

允许在当前 Workspace 内读取、写入、列目录和执行 Shell。Shell 的 cwd 必须位于 Workspace；危险命令仍按操作策略请求审批。`workspace` 是默认推荐 Profile。

不在 Phase 1 提供 `full-access` Profile。

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
  operation: 'file.read' | 'file.write' | 'shell.execute'
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

Phase 1 Agent Tool 只有 `file.read`、`file.write`、`file.list`、`shell.execute`。`process.spawn` 是 Rust 内部实现细节，不作为独立 Agent Tool 或独立审批项。

浏览器、网络域名、脚本、下载、剪贴板、Asset 导出和系统应用打开不属于 Phase 1A；Phase 1B 仅在需要系统浏览器打开时增加明确的 `resource.open.external`。

## 审计

记录请求来源、operation、workspace、路径/命令摘要、用户决策、grant scope、执行结果和拒绝原因；凭据和完整敏感输入不得进入日志或事件。

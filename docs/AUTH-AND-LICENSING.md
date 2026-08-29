# Auth and Licensing（账号与商业许可）

本文档回答两个容易被混为一谈的问题：**应用本身怎么门禁**（激活码/许可）和**云功能怎么认证**（账号登录）。当前阶段两者都不实现；本文档的作用是固定边界、预留命名空间，防止后续实现把门禁塞进错误的层。

## 1. 术语与范围

| 概念                                | 回答的问题                                                                    | 引入阶段                                 |
| ----------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| **Licensing（商业许可/激活码）**    | "这个应用/这些功能是否被授权使用"                                             | Phase 6（Desktop Hardening），随分发引入 |
| **Account/Auth（账号登录）**        | "你是谁"——云同步、团队协作、托管 Provider 的身份                              | 仅在云功能阶段引入，不为登录而登录       |
| **Permission/Approval（工具权限）** | "这个操作是否被批准"——已由 Policy Gateway 与 deny-by-default enforcement 覆盖 | 1A-2 起                                  |

三者是独立边界。许可不是安全沙箱，账号不是许可，工具审批不关心商业身份。**任何一层都不得用另一个词指代本层**（如把激活叫"权限校验"写入契约）。

## 2. 阶段策略

- **MVP / Phase 1A**：无激活、无登录，冷启动直达。与"无 API Key 仍可进入应用"是同一条产品原则。
- **Phase 6**：引入激活码许可：离线优先验证、设备绑定、宽限期、撤销。放在分发阶段是因为激活方式（试用/买断/订阅）取决于分发模式，先确定分发再定许可形态。
- **云阶段（未来）**：账号体系只服务于真实云功能（同步、团队、托管模型密钥）。登录不替代激活，激活不要求账号。

## 3. Licensing 架构（Phase 6 实现）

### 验证位置

- 验证与 enforcement 在 **TypeScript Runtime**（业务 canonical 侧）与 Host 侧完成；**前端只负责展示状态和提交激活码**。UI 隐藏入口不是 enforcement。
- 门禁体现为 bootstrap 状态机新增 `activation-required` 状态（位于 `ready` 之前，与计划中的 `provider-required` 同级）：未激活时 Runtime 拒绝业务命令并返回稳定 error，而不是依赖前端隐藏按钮。

### 离线优先

- License = **Ed25519 签名的载荷**：`{ licenseId, licensee, features, issuedAt, expiresAt?, deviceBinding }`。公钥随应用分发，本地验签，无网络也能工作。
- 激活流程：激活码 →（可选）激活服务换发设备绑定 license → 本地验签 → 落库。同时支持纯离线模式：直接导入预签名 license 文件。
- 设备绑定使用**随机安装 ID**（首次启动生成，存本地），不采集硬件序列号——隐私原则优先。

### 存储

- SQLite 新增 `licenses` 表（canonical state，Runtime 单写）：license 载荷、验签时间戳、状态（active/expired/revoked/grace）。
- 激活过程的任何机密凭据走 Keychain，复用 `docs/PROVIDER-AND-SECRETS.md` 的 secret reference 边界，不落明文。

### 宽限与撤销

- 有网络时周期性在线校验（间隔天数级）；校验失败进入宽限期（如 14 天），宽限内功能完整；宽限耗尽降级为未激活状态。撤销通过在线校验或撤销列表生效。

### 契约预留（现在不实现，命名保留）

- 命令：`license.status`、`license.activate`、`license.deactivate`。
- capability：`licensing`（加入 contracts 的 `Capability` 枚举）。
- bootstrap 状态：`activation-required`。
- SQLite 表：`licenses`（不建表，只留 schema 规划）。

## 4. Account/Auth 架构（云阶段实现）

- 触发条件：云同步、团队、托管 Provider 之一立项时才设计细节。当前只固定原则：
- OAuth 2.1 + PKCE，**系统浏览器**完成认证（与 `docs/BROWSER-SURFACE.md` "外链走系统浏览器"一致），本地 loopback 或深链回跳。
- Token 存 Keychain；会话刷新由 Runtime 负责；UI 只展示登录态。
- 账号与许可解耦：账号是身份，许可是授权；席位（seat）计数在服务端，客户端只呈现结果。

## 5. 威胁模型与诚实边界

桌面端许可**无法防御决心攻击者**——客户端二进制可被补丁，任何本地校验都可被移除。本设计的现实目标是：

1. 合法用户体验顺畅（离线可用、换机可自助）；
2. 提高随意复制/滥用的成本；
3. 支持试用、撤销、席位管理与审计。

可选加固（均为提高成本，非安全边界）：Rust 侧对签名 license token 二次校验、代码签名、校验器混淆。全部属于 Phase 6+，且明确写入非目标：**不承诺 DRM 级防护**。

## 6. 与现有架构的接缝

- 许可状态不参与 sidecar 健康语义：激活失败是独立门禁状态，**不是** `error`，也不影响 `runtime.ready` 的协议含义。
- 激活服务（如上线）是外部 Provider，遵循与模型 Provider 同样的边界：不在 Runtime 核心路径硬编码，配置化接入。
- 未来引入许可时，`AGENTS.md` 架构红线相应扩充；在那之前，`license.*`、`licensing`、`activation-required` 为保留命名，不得挪作他用。

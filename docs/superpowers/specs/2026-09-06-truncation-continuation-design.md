# 截断结果可感知与分页续读设计

## 背景

项目中部分目录与搜索结果存在数量、文件大小、输出字节数和模型上下文限制。部分结果已有 `truncated` 标记，但 `file.list` 的 Rust 实现会静默截断，workspace 文件树契约也无法告知前端或 Agent 结果不完整。开发者搜索流程还可能因输出通道限制只看到部分结果，从而误判实现不存在。

## 目标

- 所有可能截断的 Agent 工具结果都让模型明确知道结果不完整。
- `file.list` 采用 Agent 主动分页续读，不一次性返回全部结果。
- workspace 文件树能感知目录列表截断，并支持继续加载。
- 结果提示包含继续调用所需的明确参数，避免 Agent 只能猜测。
- 搜索和目录枚举流程在大目录下分批执行，避免工具输出本身被通道截断。
- 不改变既有 workspace 边界、权限和跨平台路径规则。

## 非目标

- 不取消现有安全上限、超时或上下文预算。
- 不把所有分页结果自动合并成一次大响应。
- 不实现新的 Agent 计划工具；继续使用已有 `apps/runtime/src/agent/tools/plans.ts`。

## 方案

### Agent `file.list`

Rust 文件服务将列表结果从裸数组改为带元数据的对象，至少包含：

- `entries`
- `truncated`
- `returnedCount`
- `nextOffset`（仍有后续内容时存在）

请求增加可选 `offset` 和 `limit`。非递归目录列表按稳定排序后的条目分页；递归列表按稳定路径顺序分页，并在遍历结果达到服务上限时设置 `truncated`。`nextOffset` 指向下一次请求的偏移量。工具描述和模型可见结果提示明确要求在 `truncated=true` 时用同一 `path`、`recursive` 和 `offset=nextOffset` 继续调用，或缩小范围。

为避免遍历顺序不稳定，递归结果在分页前按路径排序。服务仍保留最大单次返回限制；超出硬上限时通过 `truncated` 表示无法仅靠同一请求完整返回，Agent 可用子目录或 glob 分区继续读取。

### glob、grep 与模型结果二次截断

保留 glob/grep 现有服务端 `truncated` 语义，并统一工具结果规范：结果中保留原始截断字段，模型回填层在发现结构化结果中的 `truncated=true` 或文本达到模型上限时，追加明确的续读指引。对于没有可行 offset 的搜索结果，提示 Agent 缩小 glob、指定目录、增加过滤条件或分区查询，而不是宣称已查全。

### workspace 文件树

`workspace.list_dir` 契约与 handler 透传 `truncated`、`returnedCount`、`nextOffset`。前端目录节点保存分页状态，首次加载后若有后续内容显示“加载更多”，继续请求相同目录并使用 `nextOffset`。目录排序保持稳定，加载更多结果追加且去重。若达到递归/遍历硬上限，UI 明确显示结果不完整并建议缩小目录范围。

### 开发者搜索与输出通道

涉及仓库全局搜索的内部流程不使用可能淹没输出的无界递归目录列举。搜索入口采用候选文件模式分批、限定结果数量、读取工具完整输出文件或按偏移继续读取的方式。任何命令或工具输出达到上限时，必须检查截断标记或输出文件，而不是仅依据首段输出下结论。工具层和脚本层的分页/分批行为统一通过可验证的返回元数据表达。

## 数据流

1. Agent 调用 `file.list(path, recursive, offset, limit)`。
2. Runtime 工具校验并转发参数到 System Runtime。
3. Rust 服务稳定排序、按 offset/limit 取页并返回截断元数据。
4. Runtime 将完整工具结果落库；模型回填保留结构化截断信息并附续读指引。
5. Agent 依据 `nextOffset` 再次调用，或按提示缩小范围。
6. workspace API 复用同一分页结果，前端追加展示并更新节点状态。

## 错误与边界

- offset 超过结果总数返回空页和稳定的非错误状态；非法负数由契约拒绝或归一化为 0，遵循现有参数规范。
- `limit` 仍受服务端最大值约束，实际返回数量以 `returnedCount` 为准。
- 遍历遇到权限错误、已删除文件或符号链接时沿用现有安全语义；只有确实因上限导致不完整时设置 `truncated`。
- 模型结果字符上限仍然有效；二次截断提示不得伪造 `nextOffset`，应说明需缩小范围或分批调用。
- Windows、macOS、Linux 均使用既有路径抽象，不拼接平台分隔符。

## 测试

- Rust：非递归和递归 `file.list` 的 offset/limit、稳定排序、`truncated`、`nextOffset`、硬上限行为。
- Runtime：工具参数转发、截断结果续读提示、完整结果落库与模型结果分离。
- Contracts：新结果 schema 及兼容性验证。
- Workspace：handler/API 透传和前端“加载更多”、追加去重、截断提示。
- 搜索：大目录分批检索，以及 glob/grep 截断时的明确提示。
- 按项目规范执行 format、lint、根类型检查、desktop 类型检查、Rust fmt/check/test；可行时运行相关单测和 workspace 冒烟测试。

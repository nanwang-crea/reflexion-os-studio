# File Tool Contract

文件工具由 Runtime 暴露模型接口，由 Rust system runtime 执行真实文件系统操作。
所有路径均为 workspace 相对路径；授权、边界校验、敏感路径拒绝和最终 revision
校验必须在 Rust 侧完成。

## 读取凭据

`file.read` 返回 `mtime + size + sha256` revision。Runtime 仅在一次读取同时满足以下
条件时把它标记为“完整读取”：

- `offset = 0`；
- Rust 返回 `readComplete = true`；
- Runtime 的模型回填窗口没有因字符预算再次截断。

分页读取仍可为 `file.edit` 提供陈旧检测凭据，但不能授权 `file.write` 覆盖已有文件。
读取状态中的路径按跨平台 workspace 相对路径规范化，避免 `./a`、`a` 和 Windows
分隔符形成互不一致的凭据。

读取实现按行流式扫描，整文件不再一次性载入内存；模型仍通过 `offset/limit` 获取有界
窗口。窗口最多 2 MiB，revision 的 SHA-256 在同一次扫描中覆盖完整文件。`file.grep`
对超过 2 MiB 的文本文件同样使用流式逐行匹配（大文件模式不返回上下文行）。

`file.glob` 与 `file.grep` 在结果截断时返回不透明 `nextCursor`。cursor 绑定工具名和查询
参数，不能跨查询复用；返回同时区分 `result_limit` 与 `scan_limit`，后者表示目录扫描已
触达安全硬上限，继续翻页也不保证能发现未扫描区域。

## 写入与编辑

`file.write` 用于新建文件或明确的整文件替换。覆盖已有文件要求完整读取凭据；空文件
是合法内容。写入采用同目录临时文件后原子替换：Unix 使用 `rename`，Windows 使用
带 `REPLACE_EXISTING` 与 `WRITE_THROUGH` 的系统替换操作。临时文件名包含进程号、纳秒
时间和进程内单调序号，并以 `create_new` 排他创建；提交前 `sync_all` 文件内容，Unix
替换后再同步父目录。

`file.edit` 是默认的小范围修改工具。它接受单文件 `edits[]`，一次读取、一次 revision
校验、一次原子提交。支持：

- `replace`：精确替换，出现次数必须等于 `expectedCount`；
- `insert_before` / `insert_after`：以精确 anchor 定位；
- `replace_range`：按 1-based 闭区间行号定位，并必须同时提供 `expectedText`。

所有操作先在原始快照上解析；任一操作不匹配、范围越界或操作互相重叠，则整批不写入。
操作从文件尾向前应用，避免位置漂移。只允许 CRLF/LF 归一化和 `file.read` 行号前缀
剥离这两类确定性容错，不使用模糊匹配。旧版 `oldText/newText/expectedCount` 参数继续
兼容，并在 Rust handler 中转换为单个 `replace` 操作。

成功结果返回 revision、`changedFiles` 与 `structuredPatch`。结构化 patch 记录每个实际
修改的操作类型、原文件行范围、修改前文本和修改后文本，供模型轨迹与 UI 使用。

## 跨平台与失败语义

- macOS / Linux：同目录临时文件 + rename 覆盖，保留已有文件权限。
- Windows：同目录临时文件 + `MoveFileExW` 原子替换已有目标。
- 三个平台都先校验 workspace 边界、revision、UTF-8、文件大小和全部编辑，再落盘。
- 临时文件提交失败时清理临时文件；目标文件保持原内容。
- 任何失败均返回可自纠错误，不产生部分编辑。

稳定错误码包括 `file_not_found`、`file_not_utf8`、`file_too_large`、
`stale_revision`、`edit_mismatch`、`overlapping_edits` 与兜底 `file_error`。
Runtime 将陈旧凭据和匹配失败分别归一化为 `file_revision_conflict` 与
`file_edit_match_conflict`，其余保留 Rust 稳定码。

## 大文件流式写入

普通 `file.write` 仍受 2 MiB System Runtime 上限和更小的模型参数预检约束。超过上限的
完整文件使用 `file.write_stream`：

1. `begin(path)` 创建与目标同目录的随机 staging 文件和持久化 checkpoint；已有目标需
   携带最近一次 `file.read` 返回的 revision。
2. `append(path, uploadId, offset, content)` 每块最多 512 KiB。Runtime 自动计算分块
   SHA-256，Rust 复核；offset 必须等于上次 `nextOffset`，单个上传最多 512 MiB。
3. `commit(path, uploadId)` 流式计算完整 staging SHA-256，再次检查目标 revision，执行
   `sync_all` 后原子替换目标。
4. 放弃上传时调用 `abort` 删除 staging 与 checkpoint。

分块写入不会 append 目标文件。相同 offset 和内容的 `append` 是幂等的：即使进程在
数据 fsync 后、checkpoint 更新前退出，重试也会校验已落盘字节并补齐 checkpoint。
checkpoint 位于目标同目录，因此 System Runtime 重启后仍能凭 `uploadId` 和
`nextOffset` 续传。commit 前目标文件保持不变；目标在上传期间发生变化时 commit 拒绝。
内部 staging/checkpoint 不会出现在 `file.list`、`file.glob` 或 `file.grep` 结果中。

## 编辑定位与失败恢复

同一函数或代码块的关联修改优先用一次 `replace_range` 完整块替换；独立位置
保留原子 `edits[]`。全部操作均针对原始快照，不允许依赖前一项的替换结果。
范围校验优先精确原文；仅当不匹配且每行均有对应绝对行号时，才去除读取展示的
`L<行号>: ` 前缀后再次精确校验。新内容永远按原文写入，不自动去前缀或模糊匹配。文件自身含 BOM 时，复制的
首行原文允许带 BOM，匹配时仅在文件开头确定性剥离，文件 BOM 保持原样。

contracts 的 Zod schema 是编辑参数真源，工具 JSON Schema 从它导出。各操作
有独立必填字段，拒绝未知字段、混用新旧参数、空批次与非正整数 expectedCount，
不做截断或静默纠正。Rust 同时拒绝未知字段、混用参数及零计数。

操作失败通过 JSON-RPC `error.data.details` 返回结构化诊断：0-based
`operationIndex`、`kind`、`reason`、`noChangesWritten: true`，以及适用的
行范围、匹配数量、最多 20 个精确候选行或冲突操作编号。Runtime 校验后保留于
canonical ToolOutput 的 data，正文也向模型提供诊断。诊断不附带文件正文。
陈旧 revision 必须重读；定位失败先核对对应片段并修正，再提交整批。

实现共享于 macOS / Windows / Linux，无新增平台依赖；保持现有 BOM 与 CRLF
处理及原子写入边界，LF/CRLF、Unicode 与分页绝对行号由回归测试覆盖。

### 2026-10-19 文件执行边界

文本读取仍为返回窗口提供完整 SHA-256 revision，但全文件扫描硬上限为 64MiB。单行按缓冲块处理，超长未选中行不会累积到内存。文件请求走有界 FIFO，读取段最多 4 个并发，变更形成独占屏障；主 IPC 循环继续接受取消。超时/取消不能作为“原子写入已撤销”的证明，`operation_uncertain` 禁止自动重放，需检查实际结果。

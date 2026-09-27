# Tool Safety and Recovery

## 参数校验

Agent Core 使用 Ajv 2020 按工具声明的标准 JSON Schema 编译 validator。参数在权限判断
与执行之前统一校验，支持组合约束、枚举、范围、数组约束和
`additionalProperties`；工具内部只保留跨字段和运行时状态检查。

## Web 与 MCP 不可信边界

`web.fetch` 仅允许 HTTP/HTTPS，拒绝 URL 凭据、本机、私网、链路本地、保留和组播
地址。每次请求先解析全部地址，只要其中一个地址不公开就拒绝；连接固定到已验证 IP，
避免 DNS rebinding，并对每一跳重定向重新执行同一检查。最多跟随 5 次重定向，20 秒
超时，网络层最多缓冲 2 MiB。

Web 与 MCP 的 `ToolOutput.provenance` 都标记为 `untrusted_external`，正文带明确隔离
边界。模型、历史、UI 和审计使用同一个 canonical `ToolOutput` 投影，不把工具返回的
指令样式文本提升为系统指令。

## Shell 输出

`shell.execute` 接受 1–120 秒的显式 `timeoutMs`。一次 Run 内最多保留 16 份输出，首次
结果仅内联 stdout/stderr 各 12,000 字符，并返回 `outputId`；模型可通过
`shell.output.read` 按 offset 继续读取。Rust 侧捕获设为 8 MiB 硬上限，达到上限时明确
设置截断标志。Run 结束或进程重启后 spool 失效，不作为持久历史。

## ReadState checkpoint

`FileReadState` 的 revision 与完整读取标志写入当前非终态 `TurnExecution.runtimeState`。
重建工具注册表时从最新 Turn 恢复，因此审批、用户输入或进程恢复后仍能执行安全的
revision 条件写入。迁移 v35 为旧数据库增加 nullable `runtime_state_json`，旧 Turn 保持
兼容。

# Context Management

Context 是 Agent、Memory、Skill、Tool 和模型之间的显式数据边界，不允许通过全局变量隐式共享。

Context Pipeline：

```text
任务输入 → Session facts → Project memory → Skill instructions → Tool summaries → Token budget → Model request
```

Working Context 只属于一个 Run；Session Context 属于会话；Project Context 属于 Workspace；子 Agent 默认获得经过筛选的任务 Context，而不是完整父对话。Context Envelope 记录来源、范围、敏感级别和 token 预算。压缩时优先保留用户目标、约束、决定和未完成步骤，原始工具输出通过引用按需加载。

Context 必须支持截断、摘要、恢复和审计；敏感信息不因上下文拼接自动扩大可见范围。

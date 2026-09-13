//! 集成终端：shell 选择、PTY 会话、有界输出队列、服务级路由。
pub mod output_queue;
pub mod service;
pub mod session;
// 与 crate 顶层 `shell`（批处理 shell.execute）是两个领域，刻意命名区分，勿合并。
pub mod shell_command;

//! git 子系统模块：状态/分支（status）、diff 内容读取（diff）、
//! git 进程执行（exec）。对外仅暴露 `service::{status, diff, branches}`。

mod diff;
mod exec;
pub mod service;
mod status;

pub use service::{branches, diff, status};

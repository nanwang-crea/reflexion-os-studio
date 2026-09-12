//! Windows 沙箱执行器：CreateProcessAsUserW（受限令牌）+ 匿名管道 + Job Object。
//! 写边界：spawn 前对 writable_roots 打 LOW 完整性标签（失败 fail-closed）。
//! 临时目录：专用子目录 <TEMP>/reflexion-sandbox（打标签后经 TMP/TEMP 环境变量重定向，
//! 不给整个用户 TEMP 打标签）。输出上限/轮询节奏/超时语义与 shell.rs 对齐
//! （256KiB 截断、25ms 轮询、超时 TerminateJobObject 整树终止）。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows::Win32::Security::SECURITY_ATTRIBUTES;
use windows::Win32::Storage::FileSystem::ReadFile;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetExitCodeProcess, ResumeThread, WaitForSingleObject, CREATE_NO_WINDOW,
    CREATE_SUSPENDED, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
};

use super::acl;
use crate::sandbox::SandboxRequest;
use crate::shell::ShellOutcome;

const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const POLL_INTERVAL_MS: u32 = 25;
const SANDBOX_TEMP_DIR: &str = "reflexion-sandbox";

/// Send-safe HANDLE wrapper for cross-thread pipe ownership transfer.
/// Wraps the raw pointer value as usize to satisfy Send bounds.
struct SendHandle(usize);
unsafe impl Send for SendHandle {}

impl SendHandle {
    fn new(h: HANDLE) -> Self {
        Self(h.0 as usize)
    }
    fn into_handle(self) -> HANDLE {
        HANDLE(self.0 as *mut _)
    }
}

pub(crate) fn exec(
    request: &SandboxRequest,
    token: HANDLE,
    on_spawn: &dyn Fn(u32),
) -> Result<ShellOutcome, String> {
    // 写边界先行：任一 root 打标签失败 → 整体失败（fail-closed，不启动进程）。
    for root in &request.writable_roots {
        acl::ensure_low_label(root)?;
    }
    let sandbox_temp = sandbox_temp_dir()?;
    acl::ensure_low_label(&sandbox_temp)?;

    unsafe {
        let (stdout_read, stdout_write) = inheritable_pipe()?;
        let (stderr_read, stderr_write) = inheritable_pipe()?;

        // 命令行引用规则与 std::process::Command 一致（含尾随反斜杠翻倍）。
        let mut cmdline: Vec<u16> = format!("cmd.exe /C {}", quote_arg(&request.command))
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let cwd: Vec<u16> = request
            .cwd
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let environment = environment_block(&sandbox_temp)?;

        let mut si = STARTUPINFOW::default();
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdOutput = stdout_write;
        si.hStdError = stderr_write;
        let mut pi = PROCESS_INFORMATION::default();
        CreateProcessAsUserW(
            Some(token),
            None,
            Some(PWSTR(cmdline.as_mut_ptr())),
            None,
            None,
            true, // 管道写端可继承：必须 TRUE
            CREATE_SUSPENDED | CREATE_NO_WINDOW,
            Some(environment.as_ptr().cast()),
            PCWSTR(cwd.as_ptr()),
            &si,
            &mut pi,
        )
        .map_err(|error| format!("sandbox CreateProcessAsUserW failed: {error}"))?;

        // Job：KILL_ON_JOB_CLOSE 兜底收割；超时用 TerminateJobObject 整树终止。
        let job = CreateJobObjectW(None, None)
            .map_err(|error| format!("CreateJobObjectW failed: {error}"))?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|error| format!("SetInformationJobObject failed: {error}"))?;
        AssignProcessToJobObject(job, pi.hProcess)
            .map_err(|error| format!("AssignProcessToJobObject failed: {error}"))?;

        on_spawn(pi.dwProcessId);
        ResumeThread(pi.hThread);

        // 读端句柄由读取线程独占并负责关闭（避免双重 CloseHandle）。
        let stdout_handle = read_pipe_to_string(stdout_read);
        let stderr_handle = read_pipe_to_string(stderr_read);

        let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
        let mut timed_out = false;
        loop {
            let wait = WaitForSingleObject(pi.hProcess, POLL_INTERVAL_MS);
            if wait == WAIT_OBJECT_0 {
                break;
            }
            if wait == WAIT_TIMEOUT && Instant::now() >= deadline || Instant::now() >= deadline {
                timed_out = true;
                let _ = TerminateJobObject(job, 1);
                WaitForSingleObject(pi.hProcess, u32::MAX);
                break;
            }
        }

        let mut exit_code: u32 = 0;
        GetExitCodeProcess(pi.hProcess, &mut exit_code)
            .map_err(|error| format!("GetExitCodeProcess failed: {error}"))?;
        let _ = CloseHandle(pi.hThread);
        let _ = CloseHandle(pi.hProcess);
        let _ = CloseHandle(stdout_write);
        let _ = CloseHandle(stderr_write);
        // KILL_ON_JOB_CLOSE：job 句柄关闭时整树收割残留子进程。
        let _ = CloseHandle(job);

        let (stdout, stdout_truncated) = stdout_handle.join().unwrap_or_default();
        let (stderr, stderr_truncated) = stderr_handle.join().unwrap_or_default();
        Ok(ShellOutcome {
            exit_code: Some(exit_code as i32),
            stdout,
            stderr,
            timed_out,
            truncated: stdout_truncated || stderr_truncated,
        })
    }
}

/// 沙盒专用临时目录：<TEMP>/reflexion-sandbox（存在性惰性创建）。
fn sandbox_temp_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(SANDBOX_TEMP_DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("sandbox temp dir create failed: {error}"))?;
    Ok(dir)
}

/// 继承父进程环境，仅把 TMP/TEMP 重定向到沙盒临时目录（UTF-16 双 NUL 结尾块）。
fn environment_block(redirect_temp: &Path) -> Result<Vec<u16>, String> {
    let temp_value = redirect_temp.to_string_lossy().into_owned();
    let mut block = String::new();
    let mut redirected = false;
    for entry in std::env::vars_os() {
        let (key, value) = match entry {
            (key, value) => (
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            ),
        };
        let upper = key.to_ascii_uppercase();
        if upper == "TMP" || upper == "TEMP" {
            if redirected {
                continue;
            }
            redirected = true;
            block.push_str(&format!("TMP={temp_value}\0TEMP={temp_value}\0"));
            continue;
        }
        block.push_str(&format!("{key}={value}\0"));
    }
    if !redirected {
        block.push_str(&format!("TMP={temp_value}\0TEMP={temp_value}\0"));
    }
    block.push('\0');
    Ok(block.encode_utf16().collect())
}

/// 双端可继承匿名管道；读端立即去继承，避免子进程持有读端导致 EOF 不达。
unsafe fn inheritable_pipe() -> Result<(HANDLE, HANDLE), String> {
    let mut sa = SECURITY_ATTRIBUTES::default();
    sa.nLength = std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32;
    sa.bInheritHandle = true.into();
    let mut read = HANDLE::default();
    let mut write = HANDLE::default();
    CreatePipe(&mut read, &mut write, Some(&sa), 0)
        .map_err(|error| format!("CreatePipe failed: {error}"))?;
    // 去继承：读端不应被子进程继承（子进程只需持有写端）。
    // mask = HANDLE_FLAG_INHERIT（要操作的位），flags = HANDLE_FLAGS(0)（清除该位）。
    SetHandleInformation(read, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0))
        .map_err(|error| format!("SetHandleInformation failed: {error}"))?;
    Ok((read, write))
}

/// 读端循环：与 shell.rs drain_pipe 同语义（8KiB 缓冲、256KiB 截断、丢读保畅通）。
/// 句柄所有权归本线程，EOF 后负责 CloseHandle。
fn read_pipe_to_string(pipe: HANDLE) -> std::thread::JoinHandle<(String, bool)> {
    let pipe = SendHandle::new(pipe);
    std::thread::spawn(move || {
        let pipe = pipe.into_handle();
        let mut collected: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut buffer = [0u8; 8192];
        unsafe {
            loop {
                let mut read: u32 = 0;
                let ok = ReadFile(pipe, Some(&mut buffer[..]), Some(&mut read), None);
                if ok.is_err() || read == 0 {
                    break;
                }
                let remaining = MAX_OUTPUT_BYTES.saturating_sub(collected.len());
                if remaining == 0 {
                    truncated = true;
                    continue;
                }
                let take = (read as usize).min(remaining);
                collected.extend_from_slice(&buffer[..take]);
                if take < read as usize {
                    truncated = true;
                }
            }
            let _ = CloseHandle(pipe);
        }
        (String::from_utf8_lossy(&collected).into_owned(), truncated)
    })
}

/// 与 std::process::Command 的 Windows 参数引用规则一致。
fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.bytes().any(|b| b == b' ' || b == b'\t' || b == b'"') {
        return arg.to_string();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                quoted.push(ch);
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

//! CEF-triggered deadlines plus a bounded drain for native loop deferred tasks.
//! After the drain, the worker sleeps indefinitely until CEF schedules new work.
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
#[derive(Default)]
struct State {
    deadline: Option<Instant>,
    stopped: bool,
    drain: u8,
}
static PUMP: OnceLock<(Mutex<State>, Condvar)> = OnceLock::new();
fn shared() -> &'static (Mutex<State>, Condvar) {
    PUMP.get_or_init(|| (Mutex::new(State::default()), Condvar::new()))
}
pub fn schedule(delay_ms: i64) {
    let (lock, changed) = shared();
    let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
    if !state.stopped {
        state.drain = 64;
        state.deadline = Some(Instant::now() + Duration::from_millis(delay_ms.max(0) as u64));
        changed.notify_one();
    }
}
pub fn bind(_app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let (lock, changed) = shared();
        let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if state.stopped {
                break;
            }
            if let Some(deadline) = state.deadline {
                let now = Instant::now();
                if deadline <= now {
                    state.deadline = None;
                    drop(state);
                    #[cfg(target_os = "macos")]
                    dispatch2::DispatchQueue::main().exec_async(|| {
                        if super::ready() {
                            cef::do_message_loop_work();
                        }
                    });
                    #[cfg(not(target_os = "macos"))]
                    let _ = _app.run_on_main_thread(|| {
                        if super::ready() {
                            cef::do_message_loop_work();
                        }
                    });
                    state = lock.lock().unwrap_or_else(|e| e.into_inner());
                } else {
                    state = changed
                        .wait_timeout(state, deadline - now)
                        .unwrap_or_else(|e| e.into_inner())
                        .0;
                }
            } else if state.drain > 0 {
                state.drain -= 1;
                state.deadline = Some(Instant::now() + Duration::from_millis(16));
            } else {
                state = changed.wait(state).unwrap_or_else(|e| e.into_inner());
            }
        }
    });
    schedule(0);
}
pub fn stop() {
    let (lock, changed) = shared();
    lock.lock().unwrap_or_else(|e| e.into_inner()).stopped = true;
    changed.notify_all();
}

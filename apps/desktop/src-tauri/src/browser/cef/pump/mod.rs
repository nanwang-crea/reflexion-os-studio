//! A single main-thread dispatch owns CEF pumping and deferred native mutations.
mod scheduler;
use scheduler::Scheduler;
use std::{
    collections::VecDeque,
    sync::{Condvar, Mutex, OnceLock},
    time::{Duration, Instant},
};
type Task = Box<dyn FnOnce() + Send>;
#[derive(Default)]
struct State {
    scheduler: Scheduler,
    tasks: VecDeque<Task>,
}
static PUMP: OnceLock<(Mutex<State>, Condvar)> = OnceLock::new();
fn shared() -> &'static (Mutex<State>, Condvar) {
    PUMP.get_or_init(|| (Mutex::new(State::default()), Condvar::new()))
}
pub fn schedule(delay_ms: i64) {
    let (lock, changed) = shared();
    let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
    state.scheduler.schedule(
        Instant::now(),
        Duration::from_millis(delay_ms.max(0) as u64),
    );
    changed.notify_one();
}
pub fn defer(task: impl FnOnce() + Send + 'static) {
    let (lock, changed) = shared();
    let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
    if state.scheduler.stopped {
        return;
    }
    state.tasks.push_back(Box::new(task));
    state.scheduler.schedule(Instant::now(), Duration::ZERO);
    changed.notify_one();
}
fn run() {
    let (lock, _changed) = shared();
    if !lock
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .scheduler
        .enter()
    {
        return;
    }
    #[cfg(target_os = "macos")]
    objc2::rc::autoreleasepool(|_| run_inner());
    #[cfg(not(target_os = "macos"))]
    run_inner();
    // Native autoreleases can invoke callbacks too; retain the guard until drained.
    let (lock, changed) = shared();
    let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
    let pending = !state.tasks.is_empty();
    state.scheduler.finish(Instant::now(), pending);
    changed.notify_one();
}
fn run_inner() {
    let (lock, _) = shared();
    // Keep running=true through native callbacks and nested AppKit modal loops.
    if super::ready() {
        cef::do_message_loop_work();
    }
    // Leave pending closures in the owned queue so stop() drops their CEF refs
    // before CefShutdown. Newly deferred tasks wait for the next pump turn.
    let count = lock.lock().unwrap_or_else(|e| e.into_inner()).tasks.len();
    for _ in 0..count {
        let task = {
            let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
            if state.scheduler.stopped {
                break;
            }
            state.tasks.pop_front()
        };
        if let Some(task) = task {
            task();
        }
    }
}
pub fn bind(_app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let (lock, changed) = shared();
        let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if state.scheduler.stopped {
                break;
            }
            let now = Instant::now();
            if state.scheduler.claim(now) {
                drop(state);
                #[cfg(target_os = "macos")]
                dispatch2::DispatchQueue::main().exec_async(run);
                #[cfg(not(target_os = "macos"))]
                if _app.run_on_main_thread(run).is_err() {
                    stop();
                }
                state = lock.lock().unwrap_or_else(|e| e.into_inner());
            } else if state.scheduler.posted
                || state.scheduler.running
                || state.scheduler.deadline.is_none()
            {
                state = changed.wait(state).unwrap_or_else(|e| e.into_inner());
            } else if let Some(deadline) = state.scheduler.deadline {
                state = changed
                    .wait_timeout(state, deadline.saturating_duration_since(now))
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
        }
    });
    schedule(0);
}
pub fn stop() {
    let (lock, changed) = shared();
    let tasks = {
        let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
        state.scheduler.stop();
        std::mem::take(&mut state.tasks)
    };
    drop(tasks);
    changed.notify_all();
}

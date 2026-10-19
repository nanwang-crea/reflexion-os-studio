//! Bounded FIFO file executor: concurrent read segments, exclusive mutations.
//! IPC stays responsive to cancellation while filesystem work is in progress.
use crate::protocol::{emit, error_response};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, SyncSender},
    Arc, Mutex, OnceLock,
};
use std::thread::JoinHandle;

type Handler = fn(&Value) -> (Value, bool);
struct Job {
    request: Value,
    cancelled: Arc<AtomicBool>,
    handler: Handler,
}
fn active() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}
thread_local! { static CANCELLED: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) }; }
fn key(id: &Value) -> String {
    id.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| id.to_string())
}
pub fn check_cancelled() -> Result<(), String> {
    CANCELLED.with(|flag| {
        if flag
            .borrow()
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Acquire))
        {
            Err("file operation cancelled".into())
        } else {
            Ok(())
        }
    })
}
pub fn cancel(id: &Value) {
    if let Ok(map) = active().lock() {
        if let Some(flag) = map.get(&key(id)) {
            flag.store(true, Ordering::Release);
        }
    }
}
fn execute(job: Job) {
    let id = job.request.get("id").cloned().unwrap_or(Value::Null);
    CANCELLED.with(|flag| *flag.borrow_mut() = Some(job.cancelled.clone()));
    let response = if job.cancelled.load(Ordering::Acquire) {
        error_response(
            id.clone(),
            -32000,
            "file operation cancelled before execution",
            Some(json!({"code":"cancelled"})),
        )
    } else {
        (job.handler)(&job.request).0
    };
    if !response.is_null() {
        emit(response);
    }
    if let Ok(mut map) = active().lock() {
        map.remove(&key(&id));
    }
    CANCELLED.with(|flag| *flag.borrow_mut() = None);
}
fn sender() -> &'static SyncSender<Job> {
    static SENDER: OnceLock<SyncSender<Job>> = OnceLock::new();
    SENDER.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel::<Job>(64);
        std::thread::spawn(move || {
            let mut reads: Vec<JoinHandle<()>> = Vec::new();
            for job in rx {
                let read = matches!(
                    job.request["method"].as_str(),
                    Some(
                        "file.read" | "file.read_binary" | "file.list" | "file.glob" | "file.grep"
                    )
                );
                if read {
                    if reads.len() == 4 {
                        let _ = reads.remove(0).join();
                    }
                    reads.push(std::thread::spawn(move || execute(job)));
                } else {
                    for read in reads.drain(..) {
                        let _ = read.join();
                    }
                    execute(job);
                }
                reads.retain(|read| !read.is_finished());
            }
        });
        tx
    })
}
pub fn submit(request: Value, handler: Handler) {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = active().lock() {
        map.insert(key(&id), cancelled.clone());
    }
    if sender()
        .try_send(Job {
            request,
            cancelled,
            handler,
        })
        .is_err()
    {
        if let Ok(mut map) = active().lock() {
            map.remove(&key(&id));
        }
        emit(error_response(
            id,
            -32000,
            "file executor busy; no operation executed",
            Some(json!({"code":"busy"})),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    static STARTED: AtomicBool = AtomicBool::new(false);
    static RELEASE: AtomicBool = AtomicBool::new(false);
    static SECOND: AtomicBool = AtomicBool::new(false);
    static WRITE: AtomicBool = AtomicBool::new(false);
    fn handler(request: &Value) -> (Value, bool) {
        match request["id"].as_u64().unwrap() {
            90001 => {
                STARTED.store(true, Ordering::Release);
                while !RELEASE.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
            90002 => {
                WRITE.store(true, Ordering::Release);
            }
            _ => {
                SECOND.store(true, Ordering::Release);
            }
        }
        (Value::Null, false)
    }
    #[test]
    fn cancelled_queued_write_never_executes_or_overtakes_active_read() {
        submit(json!({"id":90001,"method":"file.read"}), handler);
        let start = Instant::now();
        while !STARTED.load(Ordering::Acquire) {
            assert!(start.elapsed() < Duration::from_secs(2));
            std::thread::sleep(Duration::from_millis(1));
        }
        submit(json!({"id":90002,"method":"file.write"}), handler);
        submit(json!({"id":90003,"method":"file.read"}), handler);
        cancel(&json!(90002));
        assert!(!WRITE.load(Ordering::Acquire));
        assert!(!SECOND.load(Ordering::Acquire));
        RELEASE.store(true, Ordering::Release);
        while !SECOND.load(Ordering::Acquire) {
            assert!(start.elapsed() < Duration::from_secs(2));
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(!WRITE.load(Ordering::Acquire));
    }
}

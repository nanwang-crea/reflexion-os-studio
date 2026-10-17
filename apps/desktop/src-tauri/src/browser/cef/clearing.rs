use cef::*;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc::Sender,
    Arc, Mutex,
};
static CLEARING: AtomicBool = AtomicBool::new(false);
struct Completion {
    remaining: AtomicUsize,
    done: Mutex<Option<Sender<Result<(), String>>>>,
}
impl Completion {
    fn finish(&self) {
        if self.remaining.fetch_sub(1, Ordering::AcqRel) == 1 {
            CLEARING.store(false, Ordering::Release);
            if let Some(done) = self.done.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = done.send(Ok(()));
            }
        }
    }
}
wrap_completion_callback! {struct CacheDone{state:Arc<Completion>} impl CompletionCallback {fn on_complete(&self){self.state.finish();}}}
pub fn active() -> bool {
    CLEARING.load(Ordering::Acquire)
}
pub fn clear(
    app: &tauri::AppHandle,
    websites: bool,
    cache: bool,
    done: Sender<Result<(), String>>,
) {
    if CLEARING.swap(true, Ordering::AcqRel) {
        let _ = done.send(Err("浏览数据正在清理".into()));
        return;
    }
    let context = match super::contexts::user(app) {
        Ok(context) => context,
        Err(error) => {
            CLEARING.store(false, Ordering::Release);
            let _ = done.send(Err(error));
            return;
        }
    };
    if websites {
        if let Err(error) = super::storage::rotate(app) {
            CLEARING.store(false, Ordering::Release);
            let _ = done.send(Err(error));
            return;
        }
        super::registry::reset_user(app);
    }
    let state = Arc::new(Completion {
        remaining: AtomicUsize::new(1 + cache as usize),
        done: Mutex::new(Some(done)),
    });
    if cache {
        let mut callback = CacheDone::new(state.clone());
        context.clear_http_cache(Some(&mut callback));
    }
    state.finish();
}

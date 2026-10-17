//! Native user input is disabled while the Agent owns a page; CDP remains usable.
#[cfg(target_os = "macos")]
mod macos {
    use super::super::registry::Policy;
    use objc2::{define_class, msg_send, rc::Retained, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::NSView;
    use objc2_foundation::{NSPoint, NSRect};
    use std::{
        cell::RefCell,
        collections::HashMap,
        sync::{atomic::Ordering, Arc},
    };
    struct GuardState {
        policy: Arc<Policy>,
    }
    define_class!(
        #[unsafe(super(NSView))]
        #[ivars=GuardState]
        struct GuardView;
        impl GuardView {
            #[unsafe(method(hitTest:))]
            unsafe fn hit_test(&self,point:NSPoint)->*mut NSView {
                use objc2::DefinedClass;
                if self.ivars().policy.locked.load(Ordering::Acquire) {std::ptr::null_mut()} else {unsafe{msg_send![super(self),hitTest:point]}}
            }
        }
    );
    thread_local! {static CONTAINERS:RefCell<HashMap<u32,Retained<NSView>>>=RefCell::new(HashMap::new());}
    pub fn create(
        id: u32,
        parent: &NSView,
        policy: Arc<Policy>,
    ) -> Result<*mut std::ffi::c_void, String> {
        let marker = MainThreadMarker::new().ok_or("CEF requires main thread")?;
        let view = GuardView::alloc(marker).set_ivars(GuardState { policy });
        let view: Retained<GuardView> = unsafe {
            msg_send![super(view),initWithFrame:NSRect::new(NSPoint::new(0.0,0.0),objc2_foundation::NSSize::new(1280.0,720.0))]
        };
        view.setHidden(true);
        parent.addSubview(&view);
        let view: Retained<NSView> = view.into_super();
        let pointer = (&*view) as *const NSView as *mut std::ffi::c_void;
        CONTAINERS.with(|r| {
            r.borrow_mut().insert(id, view);
        });
        Ok(pointer)
    }
    pub fn remove(id: u32) {
        if let Some(view) = CONTAINERS.with(|r| r.borrow_mut().remove(&id)) {
            view.removeFromSuperview();
        }
    }
}
#[cfg(target_os = "macos")]
pub use macos::{create, remove};
#[cfg(not(target_os = "macos"))]
pub fn remove(_: u32) {}

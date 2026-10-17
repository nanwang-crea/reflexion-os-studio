use cef::application_mac::{CefAppProtocol, CrAppControlProtocol, CrAppProtocol};
use objc2::{define_class, extern_methods, msg_send, rc::Retained, runtime::Bool, DefinedClass};
use objc2_app_kit::{NSApplication, NSEvent};
use std::cell::Cell;

#[derive(Default)]
pub struct ApplicationState {
    sending: Cell<Bool>,
}
define_class!(
    #[unsafe(super(NSApplication))]
    #[ivars = ApplicationState]
    struct BrowserApplication;
    impl BrowserApplication {
        #[unsafe(method(sendEvent:))]
        unsafe fn send_event(&self, event: &NSEvent) {
            let previous = self.ivars().sending.replace(Bool::YES);
            let _: () = unsafe { msg_send![super(self), sendEvent: event] };
            self.ivars().sending.set(previous);
        }
    }
    unsafe impl CrAppProtocol for BrowserApplication {
        #[unsafe(method(isHandlingSendEvent))]
        unsafe fn handling(&self) -> Bool { self.ivars().sending.get() }
    }
    unsafe impl CrAppControlProtocol for BrowserApplication {
        #[unsafe(method(setHandlingSendEvent:))]
        unsafe fn set_handling(&self, value: Bool) { self.ivars().sending.set(value); }
    }
    unsafe impl CefAppProtocol for BrowserApplication {}
);
impl BrowserApplication {
    extern_methods! {
        #[unsafe(method(sharedApplication))]
        fn shared_application() -> Retained<Self>;
    }
}
pub fn setup() {
    let _ = BrowserApplication::shared_application();
}

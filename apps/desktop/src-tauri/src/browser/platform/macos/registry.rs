use super::{navigation, ui_delegate};
use objc2::rc::Retained;
use objc2_foundation::NSObjectNSKeyValueObserverRegistration;
use objc2_foundation::NSRect;
use objc2_web_kit::{WKWebView, WKWebsiteDataStore};
use std::{cell::RefCell, collections::HashMap};

pub(super) struct Guest {
    pub view: Retained<WKWebView>,
    pub _navigation: Retained<navigation::NavigationDelegate>,
    pub _ui: Retained<ui_delegate::UiDelegate>,
    pub ready: bool,
}
#[derive(Default)]
pub(super) struct Registry {
    pub guests: HashMap<u32, Guest>,
    pub store: Option<Retained<WKWebsiteDataStore>>,
    pub active: Option<u32>,
    pub frame: Option<NSRect>,
    pub visible: bool,
}
thread_local! { pub(super) static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default()); }

pub(super) fn refresh() {
    REGISTRY.with(|registry| {
        let registry = registry.borrow();
        for (id, guest) in &registry.guests {
            if let Some(frame) = registry.frame {
                if guest.view.frame() != frame {
                    guest.view.setFrame(frame);
                }
            }
            let hidden = !registry.visible || registry.active != Some(*id) || !guest.ready;
            if guest.view.isHidden() != hidden {
                guest.view.setHidden(hidden);
            }
        }
    });
}
pub(super) fn mark_ready(id: u32, ready: bool) {
    REGISTRY.with(|registry| {
        if let Some(guest) = registry.borrow_mut().guests.get_mut(&id) {
            guest.ready = ready;
        }
    });
    refresh();
}
pub fn close_tab(id: u32) {
    // Release borrow before stopLoading: delegates can be called synchronously.
    let guest = REGISTRY.with(|registry| registry.borrow_mut().guests.remove(&id));
    if let Some(guest) = guest {
        unsafe {
            guest.view.removeObserver_forKeyPath(
                &guest._navigation,
                &objc2_foundation::NSString::from_str("title"),
            );
            guest.view.setNavigationDelegate(None);
            guest.view.setUIDelegate(None);
            guest.view.stopLoading();
            guest.view.removeFromSuperview();
        }
    }
}
pub fn dispose() {
    let ids =
        REGISTRY.with(|registry| registry.borrow().guests.keys().copied().collect::<Vec<_>>());
    for id in ids {
        close_tab(id);
    }
    REGISTRY.with(|registry| *registry.borrow_mut() = Registry::default());
}

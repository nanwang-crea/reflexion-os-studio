//! Native guest ownership and layout. No AppHandle or platform API calls while borrowed.
use crate::browser::state::Action;
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    rc::Rc,
};

pub(super) trait Engine {
    fn control(&self, action: &Action) -> Result<(), String>;
    fn layout(&self, bounds: Bounds, visible: bool) -> Result<(), String>;
    fn stop(&self);
}

#[derive(Clone, Copy, Default, PartialEq)]
pub(super) struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Default)]
pub(super) struct Registry {
    pub guests: HashMap<u32, Rc<dyn Engine>>,
    pub creating: HashSet<u32>,
    active: Option<u32>,
    bounds: Bounds,
    visible: bool,
    version: u64,
    refreshing: bool,
}
impl Registry {
    pub fn select(&mut self, active: Option<u32>) {
        if self.active != active {
            self.active = active;
            self.version += 1;
        }
    }
    pub fn layout(&mut self, bounds: Bounds, visible: bool) {
        if self.bounds != bounds || self.visible != visible {
            self.bounds = bounds;
            self.visible = visible;
            self.version += 1;
        }
    }
    pub fn insert(&mut self, id: u32, engine: Rc<dyn Engine>) {
        // The caller checks membership before native creation and before adoption.
        assert!(!self.guests.contains_key(&id));
        self.guests.insert(id, engine);
        self.version += 1;
    }
    pub fn remove(&mut self, id: u32) -> Option<Rc<dyn Engine>> {
        let guest = self.guests.remove(&id);
        if guest.is_some() {
            self.version += 1;
        }
        guest
    }
    pub fn clear(&mut self) -> HashMap<u32, Rc<dyn Engine>> {
        self.select(None);
        self.layout(Bounds::default(), false);
        self.creating.clear();
        self.version += 1;
        std::mem::take(&mut self.guests)
    }
}

struct RefreshGuard<'a>(&'a RefCell<Registry>);
impl Drop for RefreshGuard<'_> {
    fn drop(&mut self) {
        self.0.borrow_mut().refreshing = false;
    }
}

pub(super) fn refresh(registry: &RefCell<Registry>) -> Result<(), String> {
    {
        let mut registry = registry.borrow_mut();
        if registry.refreshing {
            return Ok(());
        }
        registry.refreshing = true;
    }
    let _guard = RefreshGuard(registry);
    // Nested requests update the version; the outer refresh applies the latest frame.
    // Bound retries so an unstable native callback cannot spin the UI thread forever.
    for _ in 0..8 {
        let (guests, bounds, active, visible, version) = {
            let registry = registry.borrow();
            (
                registry
                    .guests
                    .iter()
                    .map(|(id, engine)| (*id, engine.clone()))
                    .collect::<Vec<_>>(),
                registry.bounds,
                registry.active,
                registry.visible,
                registry.version,
            )
        };
        for (id, engine) in guests {
            if registry.borrow().version != version {
                break;
            }
            engine.layout(bounds, visible && active == Some(id))?;
        }
        if registry.borrow().version == version {
            return Ok(());
        }
    }
    Err("网页布局持续变化，请重试".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Guest {
        calls: RefCell<Vec<(f64, bool)>>,
        callback: RefCell<Option<Box<dyn FnOnce()>>>,
        fail: Cell<bool>,
    }
    impl Guest {
        fn new() -> Rc<Self> {
            Rc::new(Self {
                calls: RefCell::new(Vec::new()),
                callback: RefCell::new(None),
                fail: Cell::new(false),
            })
        }
    }
    impl Engine for Guest {
        fn control(&self, _: &Action) -> Result<(), String> {
            Ok(())
        }
        fn layout(&self, bounds: Bounds, visible: bool) -> Result<(), String> {
            self.calls.borrow_mut().push((bounds.width, visible));
            let callback = self.callback.borrow_mut().take();
            if let Some(callback) = callback {
                callback();
            }
            if self.fail.get() {
                Err("synthetic layout failure".into())
            } else {
                Ok(())
            }
        }
        fn stop(&self) {}
    }

    #[test]
    fn nested_layout_and_selection_finish_with_latest_frame() {
        let registry = Rc::new(RefCell::new(Registry::default()));
        let first = Guest::new();
        let second = Guest::new();
        {
            let mut state = registry.borrow_mut();
            state.insert(1, first.clone());
            state.insert(2, second.clone());
            state.select(Some(1));
            state.layout(
                Bounds {
                    width: 100.0,
                    ..Bounds::default()
                },
                true,
            );
        }
        let nested = registry.clone();
        *first.callback.borrow_mut() = Some(Box::new(move || {
            nested.borrow_mut().select(Some(2));
            nested.borrow_mut().layout(
                Bounds {
                    width: 200.0,
                    ..Bounds::default()
                },
                true,
            );
            refresh(&nested).unwrap();
        }));
        refresh(&registry).unwrap();
        assert_eq!(first.calls.borrow().last(), Some(&(200.0, false)));
        assert_eq!(second.calls.borrow().last(), Some(&(200.0, true)));
    }

    #[test]
    fn dispose_during_layout_hides_new_guests_and_keeps_refresh_guard() {
        let registry = Rc::new(RefCell::new(Registry::default()));
        let old = Guest::new();
        let new = Guest::new();
        registry.borrow_mut().insert(1, old.clone());
        registry.borrow_mut().select(Some(1));
        registry.borrow_mut().layout(
            Bounds {
                width: 100.0,
                ..Bounds::default()
            },
            true,
        );
        let nested = registry.clone();
        let new_guest = new.clone();
        *old.callback.borrow_mut() = Some(Box::new(move || {
            let guests = nested.borrow_mut().clear();
            drop(guests);
            assert!(nested.borrow().refreshing);
            nested.borrow_mut().insert(2, new_guest);
            refresh(&nested).unwrap();
        }));
        refresh(&registry).unwrap();
        assert_eq!(new.calls.borrow().last(), Some(&(0.0, false)));
        assert!(!registry.borrow().refreshing);
    }

    #[test]
    fn unstable_layout_is_bounded_and_releases_guard() {
        struct ChangingGuest(std::rc::Weak<RefCell<Registry>>, Cell<u32>);
        impl Engine for ChangingGuest {
            fn control(&self, _: &Action) -> Result<(), String> {
                Ok(())
            }
            fn stop(&self) {}
            fn layout(&self, _: Bounds, _: bool) -> Result<(), String> {
                self.1.set(self.1.get() + 1);
                self.0.upgrade().unwrap().borrow_mut().layout(
                    Bounds {
                        width: self.1.get() as f64,
                        ..Bounds::default()
                    },
                    true,
                );
                Ok(())
            }
        }
        let registry = Rc::new(RefCell::new(Registry::default()));
        let guest = Rc::new(ChangingGuest(Rc::downgrade(&registry), Cell::new(0)));
        registry.borrow_mut().insert(1, guest.clone());
        guest.control(&Action::Status).unwrap();
        assert!(refresh(&registry).is_err());
        assert_eq!(guest.1.get(), 8);
        assert!(!registry.borrow().refreshing);
        let removed = registry.borrow_mut().remove(1).unwrap();
        removed.stop();
        refresh(&registry).unwrap();
    }

    #[test]
    fn failed_layout_can_be_retried() {
        let registry = RefCell::new(Registry::default());
        let guest = Guest::new();
        guest.fail.set(true);
        registry.borrow_mut().insert(1, guest.clone());
        assert!(refresh(&registry).is_err());
        assert!(!registry.borrow().refreshing);
        guest.fail.set(false);
        refresh(&registry).unwrap();
        assert_eq!(guest.calls.borrow().len(), 2);
    }
}

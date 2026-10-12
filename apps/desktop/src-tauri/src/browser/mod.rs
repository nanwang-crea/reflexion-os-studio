pub mod capabilities;
pub mod commands;
pub mod import;
mod platform;
pub mod policy;
mod state;
mod tabs;
mod window;

pub use state::BrowserState;

pub fn dispose() {
    platform::dispose();
}

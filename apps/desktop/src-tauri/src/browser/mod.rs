pub mod capabilities;
pub mod commands;
pub mod downloads;
pub mod import;
mod platform;
pub mod policy;
mod preferences;
mod state;
mod tabs;
mod window;

pub use state::BrowserState;

pub fn dispose() {
    platform::dispose();
}

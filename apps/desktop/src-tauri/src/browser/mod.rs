pub mod capabilities;
pub mod commands;
mod contact;
pub mod downloads;
pub mod import;
pub mod keychain;
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

#[cfg(all(
    feature = "cef-browser",
    any(target_os = "macos", target_os = "windows")
))]
pub mod cef;

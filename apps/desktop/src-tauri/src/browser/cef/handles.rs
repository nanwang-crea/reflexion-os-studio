//! CEF's Windows HWND is a newtype; macOS uses a raw NSView pointer.
use cef::sys::cef_window_handle_t;
use std::ffi::c_void;

pub fn from_raw(raw: *mut c_void) -> cef_window_handle_t {
    #[cfg(target_os = "windows")]
    {
        cef::sys::HWND(raw.cast())
    }
    #[cfg(target_os = "macos")]
    {
        raw
    }
}

pub fn address(handle: cef_window_handle_t) -> usize {
    #[cfg(target_os = "windows")]
    {
        handle.0 as usize
    }
    #[cfg(target_os = "macos")]
    {
        handle as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_pointer_round_trip_preserves_address() {
        let mut marker = 0u8;
        let raw = (&mut marker as *mut u8).cast();
        assert_eq!(address(from_raw(raw)), raw as usize);
    }

    #[test]
    fn null_handle_round_trip_preserves_zero() {
        assert_eq!(address(from_raw(std::ptr::null_mut())), 0);
    }
}

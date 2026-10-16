#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args_os().any(|arg| arg == "--verify-frontend-assets") {
        if let Err(error) = reflexion_desktop_lib::verify_frontend_assets() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    reflexion_desktop_lib::run()
}

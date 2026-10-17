#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(all(
        feature = "cef-browser",
        any(target_os = "macos", target_os = "windows")
    ))]
    if std::env::args_os().any(|arg| arg == "--cef-distribution") {
        match reflexion_desktop_lib::cef_distribution() {
            Ok(path) => println!("{}", path.display()),
            Err(_) => std::process::exit(1),
        };
        return;
    }
    if std::env::args_os().any(|arg| arg == "--verify-frontend-assets") {
        if let Err(error) = reflexion_desktop_lib::verify_frontend_assets() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    #[cfg(all(feature = "cef-browser", target_os = "windows"))]
    {
        let executable = std::env::current_exe().expect("executable unavailable");
        let directory = executable
            .parent()
            .expect("executable directory unavailable");
        let result = std::fs::copy(
            directory.join("reflexion_desktop_lib.dll"),
            directory.join("reflexion-desktop-sandbox.dll"),
        )
        .and_then(|_| {
            std::process::Command::new(directory.join("reflexion-desktop-sandbox.exe"))
                .args(std::env::args_os().skip(1))
                .status()
        });
        match result {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            Err(_) => {
                eprintln!("CEF sandbox launcher unavailable; run pnpm prepare:cef");
                std::process::exit(1);
            }
        }
    }
    #[cfg(all(target_os = "macos", feature = "cef-browser"))]
    {
        use std::os::unix::process::CommandExt;
        let current = std::env::current_exe().expect("executable path");
        if !current
            .ancestors()
            .any(|p| p.extension().is_some_and(|e| e == "app"))
        {
            let target=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.cache/cef-native/ReflexionOS Studio Dev.app/Contents/MacOS/reflexion-desktop");
            let staged = target.with_extension(format!("{}.tmp", std::process::id()));
            std::fs::copy(&current, &staged)
                .expect("CEF development bundle missing; run pnpm prepare:cef");
            std::fs::rename(staged, &target).expect("CEF development launcher replace failed");
            let error = std::process::Command::new(target)
                .args(std::env::args_os().skip(1))
                .exec();
            panic!("CEF development launcher failed: {error}");
        }
    }
    #[cfg(not(all(feature = "cef-browser", target_os = "windows")))]
    reflexion_desktop_lib::run()
}

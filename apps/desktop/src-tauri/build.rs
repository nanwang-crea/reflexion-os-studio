use std::{env, fs, path::PathBuf};

use serde::Deserialize;

#[derive(Deserialize)]
struct RuntimeMethods {
    version: u32,
    methods: Vec<String>,
}

fn main() {
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let app_manifest_dir = out_dir.join("app-manifest");
    fs::create_dir_all(&app_manifest_dir).unwrap_or_else(|error| {
        panic!(
            "failed to create Tauri permission manifest directory {}: {error}",
            app_manifest_dir.display()
        )
    });
    tauri_build::try_build(tauri_build::Attributes::default().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "bootstrap_get_state",
            "runtime_request",
            "open_external",
            "browser_open",
            "browser_control",
            "browser_import",
            "browser_credentials",
            "browser_fill",
            "browser_clear_credentials",
        ]),
    ))
    .unwrap_or_else(|error| {
        panic!(
            "Tauri build failed (OUT_DIR={}): {error:#}",
            out_dir.display()
        )
    });

    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let manifest_path =
        manifest_dir.join("../../../packages/contracts/generated/runtime-methods.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let manifest: RuntimeMethods =
        serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap_or_else(|error| {
            panic!(
                "failed to read runtime methods manifest {}: {error}",
                manifest_path.display()
            )
        }))
        .unwrap_or_else(|error| panic!("invalid runtime methods manifest: {error}"));

    let generated = format!(
        "pub const RUNTIME_METHODS_VERSION: u32 = {};\n\
pub const RUNTIME_METHODS: [&str; {}] = [{}];\n",
        manifest.version,
        manifest.methods.len(),
        manifest
            .methods
            .iter()
            .map(|method| format!("{method:?}"))
            .collect::<Vec<_>>()
            .join(", "),
    );
    fs::write(out_dir.join("runtime_methods.rs"), generated).unwrap();
}

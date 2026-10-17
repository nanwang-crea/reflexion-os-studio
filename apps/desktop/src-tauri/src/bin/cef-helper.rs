fn main() {
    #[cfg(target_os = "macos")]
    {
        let args = cef::args::Args::new();
        let mut sandbox = cef::sandbox::Sandbox::new();
        sandbox.initialize(args.as_main_args());
        let loader =
            cef::library_loader::LibraryLoader::new(&std::env::current_exe().unwrap(), true);
        assert!(loader.load());
        let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
        let code = cef::execute_process(
            Some(args.as_main_args()),
            None::<&mut cef::App>,
            std::ptr::null_mut(),
        );
        std::process::exit(code.max(0));
    }
}

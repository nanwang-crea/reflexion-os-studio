use cef::*;
wrap_app! {
    pub struct BrowserApp { mock_keychain: bool }
    impl App {
        fn on_before_command_line_processing(&self, _process_type: Option<&CefString>, command: Option<&mut CommandLine>) {
            if let Some(command) = command {
                for (name,value) in [("remote-debugging-address","127.0.0.1"),("disable-background-networking",""),("disable-quic",""),("force-webrtc-ip-handling-policy","disable_non_proxied_udp")] {
                    command.append_switch_with_value(Some(&CefString::from(name)),Some(&CefString::from(value)));
                }
                // macOS only: keeps the os_crypt key in memory instead of the
                // login keychain, suppressing the "Chromium Safe Storage" prompt.
                if self.mock_keychain && cfg!(target_os = "macos") {
                    command.append_switch(Some(&CefString::from("use-mock-keychain")));
                }
            }
        }
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> { Some(PumpHandler::new()) }
    }
}
wrap_browser_process_handler! {
    struct PumpHandler;
    impl BrowserProcessHandler {
        fn on_schedule_message_pump_work(&self, delay_ms: i64) { super::pump::schedule(delay_ms); }
    }
}

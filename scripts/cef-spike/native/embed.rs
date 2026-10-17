use cef::*;
use objc2::msg_send;
use objc2_app_kit::NSView;
use std::cell::RefCell;
use std::time::Duration;
use tauri::Manager;

wrap_app! { pub struct EmbedApp; impl App {} }
wrap_client! { struct EmbedClient; impl Client {} }

thread_local! { static ACTIVE: RefCell<Option<Browser>> = const { RefCell::new(None) }; }

fn attach(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app.get_webview_window("main").unwrap();
    let native = window.ns_window().unwrap();
    let parent: *mut NSView =
        unsafe { msg_send![native as *mut objc2::runtime::AnyObject, contentView] };
    let info = WindowInfo {
        runtime_style: RuntimeStyle::ALLOY,
        ..Default::default()
    }
    .set_as_child(
        parent.cast(),
        &Rect {
            x: 360,
            y: 0,
            width: 740,
            height: 720,
        },
    );
    let mut client = EmbedClient::new();
    let browser = browser_host_create_browser_sync(
        Some(&info),
        Some(&mut client),
        Some(&CefString::from("about:blank")),
        Some(&BrowserSettings::default()),
        None,
        None,
    )
    .expect("CEF child browser");
    ACTIVE.with(|slot| *slot.borrow_mut() = Some(browser));
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        .setup(attach)
        .build(tauri::generate_context!())
        .expect("tauri build");
    let handle = app.handle().clone();
    let running = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let tick = running.clone();
    let thread = std::thread::spawn(move || {
        while tick.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = handle.run_on_main_thread(|| {
                do_message_loop_work();
            });
            std::thread::sleep(Duration::from_millis(16));
        }
    });
    app.run(|_, _| {});
    running.store(false, std::sync::atomic::Ordering::Relaxed);
    thread.join().unwrap();
    ACTIVE.with(|slot| {
        if let Some(browser) = slot.borrow_mut().take() {
            browser.host().unwrap().close_browser(1);
        }
    });
    for _ in 0..30 {
        do_message_loop_work();
        std::thread::sleep(Duration::from_millis(10));
    }
}

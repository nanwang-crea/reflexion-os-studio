use block2::RcBlock;
use objc2::{
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool},
};
use objc2_foundation::{NSError, NSString};
#[link(name = "LocalAuthentication", kind = "framework")]
unsafe extern "C" {}

pub fn authenticate() -> Result<(), String> {
    let class = AnyClass::get(c"LAContext").ok_or("系统认证不可用")?;
    let context: Retained<AnyObject> = unsafe { msg_send![class, new] };
    let mut error: *mut NSError = std::ptr::null_mut();
    let available: Bool =
        unsafe { msg_send![&*context, canEvaluatePolicy: 2isize, error: &mut error] };
    if !available.as_bool() {
        return Err("系统无法验证身份，密码操作未执行".into());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let reply = RcBlock::new(move |success: Bool, _error: *mut NSError| {
        let _ = tx.send(success.as_bool());
    });
    let reason = NSString::from_str("验证身份以管理本应用保存的网站密码");
    unsafe {
        let _: () =
            msg_send![&*context, evaluatePolicy: 2isize, localizedReason: &*reason, reply: &*reply];
    }
    let result = rx
        .recv_timeout(std::time::Duration::from_secs(120))
        .unwrap_or(false);
    unsafe {
        let _: () = msg_send![&*context, invalidate];
    }
    if result {
        Ok(())
    } else {
        Err("系统认证取消或失败，密码操作未执行".into())
    }
}

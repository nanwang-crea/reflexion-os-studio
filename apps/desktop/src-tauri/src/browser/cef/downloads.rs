//! CEF owns transfer IO; shared download records own safe publication and cancellation.
use super::registry::Policy;
use crate::browser::{downloads::transfers, state};
use cef::*;
use std::{cell::RefCell, collections::HashMap, path::PathBuf, sync::Arc};
struct Transfer {
    id: u64,
    stage: PathBuf,
    cancellable: bool,
}
thread_local! {static ACTIVE:RefCell<HashMap<u32,Transfer>>=RefCell::new(HashMap::new());}
wrap_download_handler! {
    pub struct Downloads { app:tauri::AppHandle, tab:u32, policy:Arc<Policy> }
    impl DownloadHandler {
        fn can_download(&self,_browser:Option<&mut Browser>,url:Option<&CefString>,method:Option<&CefString>)->i32 {
            (self.policy.origin.is_none() && state::snapshot(&self.app).active_tab_id==Some(self.tab)
                && url.is_some_and(|u|self.policy.allows(&u.to_string(),&method.map(ToString::to_string).unwrap_or_default()))) as i32
        }
        fn on_before_download(&self,_browser:Option<&mut Browser>,item:Option<&mut DownloadItem>,name:Option<&CefString>,callback:Option<&mut BeforeDownloadCallback>)->i32 {
            let (Some(item),Some(callback))=(item,callback) else{return 1;};
            if self.policy.origin.is_some() || state::snapshot(&self.app).active_tab_id!=Some(self.tab) {return 1;}
            let source=CefString::from(&item.url()).to_string();
            let original=CefString::from(&item.original_url()).to_string();
            let origin=crate::browser::policy::web_url(&original).ok().map(|url|url.origin().ascii_serialization());
            if !crate::browser::downloads::redirects::same_origin(origin.as_deref(),Some(&source)) {
                state::update_tab(&self.app,self.tab,|tab|tab.notice=Some("下载已阻止：重定向到其他来源".into()));
                return 1;
            }
            let app=self.app.clone();
            let tab=self.tab;
            let native_id=item.id();
            let callback=callback.clone();
            let name=name.map(ToString::to_string).unwrap_or_else(||"download".into());
            transfers::prepare_async(&self.app,source,name,move |result| {
                match result {
                    Ok((id,stage))=>{
                        ACTIVE.with(|r|r.borrow_mut().insert(native_id,Transfer{id,stage:stage.clone(),cancellable:false}));
                        callback.cont(Some(&CefString::from(stage.to_string_lossy().as_ref())),0);
                    }
                    Err(error)=>state::update_tab(&app,tab,|tab|tab.notice=Some(error)),
                }
            });
            1
        }
        fn on_download_updated(&self,_browser:Option<&mut Browser>,item:Option<&mut DownloadItem>,callback:Option<&mut DownloadItemCallback>) {
            let Some(item)=item else{return;};
            let current=ACTIVE.with(|r|r.borrow().get(&item.id()).map(|e|(e.id,e.stage.clone(),e.cancellable)));
            // CEF also reports progress before OnBeforeDownload. Ownership begins there.
            let Some((id,stage,cancellable))=current else {return;};
            if item.is_in_progress()!=0 {
                if !cancellable {if let Some(callback)=callback {
                    let callback=callback.clone();
                    ACTIVE.with(|r|{if let Some(e)=r.borrow_mut().get_mut(&item.id()){e.cancellable=true;}});
                    transfers::cancellation(id,move ||callback.cancel());
                }}
                transfers::progress(id,item.received_bytes().max(0) as u64,(item.total_bytes()>0).then(||item.total_bytes() as u64));
            } else {
                ACTIVE.with(|r|r.borrow_mut().remove(&item.id()));
                transfers::settled(id,item.is_complete()!=0,&stage);
            }
        }
    }
}

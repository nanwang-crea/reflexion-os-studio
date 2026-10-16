//! Verifies compiled assets without opening a window or starting user-data services.
use std::collections::BTreeSet;

pub fn verify(context: &tauri::Context<tauri::Wry>) -> Result<(), String> {
    validate(|path| {
        context
            .assets()
            .get(&path.into())
            .map(|bytes| bytes.into_owned())
    })
}

fn validate(lookup: impl Fn(&str) -> Option<Vec<u8>>) -> Result<(), String> {
    let index = lookup("/index.html")
        .filter(|bytes| !bytes.is_empty())
        .ok_or("packaged frontend is missing index.html")?;
    let html = std::str::from_utf8(&index).map_err(|_| "packaged index.html is not UTF-8")?;
    let mut paths = BTreeSet::new();
    for attribute in ["src=\"", "href=\"", "src='", "href='"] {
        let quote = attribute.chars().last().unwrap();
        for value in html.split(attribute).skip(1) {
            let path = value.split(quote).next().unwrap_or_default();
            if path.starts_with("/assets/") {
                paths.insert(path);
            }
        }
    }
    if !paths.iter().any(|path| path.ends_with(".js"))
        || !paths.iter().any(|path| path.ends_with(".css"))
    {
        return Err("packaged index.html has no frontend JS/CSS entry points".into());
    }
    for path in paths {
        if lookup(path).is_none_or(|bytes| bytes.is_empty()) {
            return Err(format!("packaged frontend entry is missing: {path}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn assets() -> BTreeMap<&'static str, Vec<u8>> {
        BTreeMap::from([
            (
                "/index.html",
                b"<script src=\"/assets/app.js\"></script><link href='/assets/app.css'>".to_vec(),
            ),
            ("/assets/app.js", b"mountApp()".to_vec()),
            ("/assets/app.css", b"body{}".to_vec()),
        ])
    }

    #[test]
    fn accepts_a_complete_embedded_frontend() {
        let files = assets();
        assert!(validate(|path| files.get(path).cloned()).is_ok());
    }

    #[test]
    fn rejects_an_empty_build_and_missing_or_empty_entry_chunks() {
        for missing in ["/index.html", "/assets/app.js", "/assets/app.css"] {
            let mut files = assets();
            files.remove(missing);
            assert!(validate(|path| files.get(path).cloned()).is_err());
            files.insert(missing, vec![]);
            assert!(validate(|path| files.get(path).cloned()).is_err());
        }
        assert!(validate(|_| None).is_err());
    }

    #[test]
    fn rejects_placeholder_html_that_cannot_boot_the_application() {
        let mut files = assets();
        files.insert("/index.html", b"asset not found: index.html".to_vec());
        assert!(validate(|path| files.get(path).cloned()).is_err());
    }
}

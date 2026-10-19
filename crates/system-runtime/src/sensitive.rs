//! Shared policy data is embedded from contracts; never inspect protected contents.
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Policy {
    names: Vec<String>,
    prefixes: Vec<String>,
    suffixes: Vec<String>,
    home_paths: Vec<String>,
    unix_paths: Vec<String>,
}
fn policy() -> &'static Policy {
    static POLICY: OnceLock<Policy> = OnceLock::new();
    POLICY.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../packages/contracts/src/security/no-read-policy.json"
        ))
        .expect("embedded no-read policy must be valid")
    })
}
pub fn protected_name(path: &Path) -> bool {
    path.components().any(|part| {
        let name = part.as_os_str().to_string_lossy().to_lowercase();
        policy().names.contains(&name)
            || policy()
                .prefixes
                .iter()
                .any(|prefix| name.starts_with(prefix))
            || policy()
                .suffixes
                .iter()
                .any(|suffix| name.ends_with(suffix))
    })
}
pub fn roots_for(home: Option<&Path>, data: &Path) -> Vec<PathBuf> {
    let mut paths = vec![data.to_path_buf()];
    if let Some(home) = home {
        for tail in &policy().home_paths {
            paths.push(home.join(tail));
        }
    }
    #[cfg(unix)]
    for path in &policy().unix_paths {
        paths.push(PathBuf::from(path));
    }
    paths
}
pub fn roots() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    roots_for(home.as_deref(), &crate::sandbox::data_dir())
}
pub fn assert_allowed(path: &Path) -> Result<(), String> {
    let canonical = crate::sandbox::deepest_resolved(path);
    if protected_name(path)
        || protected_name(&canonical)
        || roots().iter().any(|root| {
            let root = crate::sandbox::deepest_resolved(root);
            #[cfg(windows)]
            {
                let lower = canonical.to_string_lossy().to_lowercase();
                let guard = root.to_string_lossy().to_lowercase();
                lower == guard || lower.starts_with(&(guard + "\\"))
            }
            #[cfg(not(windows))]
            {
                canonical.starts_with(root)
            }
        })
    {
        return Err("sensitive path denied by no-read policy".into());
    }
    Ok(())
}
/// Character classes avoid platform-specific case-insensitive regex extensions.
pub fn path_pattern() -> String {
    let mut alternatives: Vec<String> = policy()
        .names
        .iter()
        .map(|name| {
            regex::escape(name)
                .replace("\\.", "[.]")
                .replace("\\-", "[-]")
        })
        .collect();
    alternatives.extend(policy().prefixes.iter().map(|prefix| {
        format!(
            "{}[^/]*",
            regex::escape(prefix)
                .replace("\\.", "[.]")
                .replace("\\-", "[-]")
        )
    }));
    alternatives.extend(policy().suffixes.iter().map(|suffix| {
        format!(
            "[^/]*{}",
            regex::escape(suffix)
                .replace("\\.", "[.]")
                .replace("\\-", "[-]")
        )
    }));
    let pattern = format!("(^|/)({})(/|$)", alternatives.join("|"));
    pattern
        .chars()
        .map(|ch| {
            if ch.is_ascii_lowercase() {
                format!("[{ch}{}]", ch.to_ascii_uppercase())
            } else {
                ch.to_string()
            }
        })
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_and_regex_agree_without_opening_sensitive_files() {
        let regex = regex::Regex::new(&path_pattern()).unwrap();
        for name in policy()
            .names
            .iter()
            .cloned()
            .chain(
                policy()
                    .prefixes
                    .iter()
                    .map(|prefix| format!("{prefix}.fixture")),
            )
            .chain(
                policy()
                    .suffixes
                    .iter()
                    .map(|suffix| format!("fixture{suffix}")),
            )
        {
            assert!(protected_name(Path::new(&name)));
            assert!(regex.is_match(&name));
            assert!(regex.is_match(&name.to_uppercase()));
        }
        for name in ["src/main.rs", "notes.txt", "environment.ts"] {
            assert!(!protected_name(Path::new(name)));
            assert!(!regex.is_match(name));
        }
    }
}

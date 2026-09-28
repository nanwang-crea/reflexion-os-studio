//! Workspace glob 编译：使用 globset 提供成熟的 `**`、字符类与花括号语义。
//! 不含 `/` 的 pattern 按任意层级 basename 匹配，与 ripgrep `--glob` 一致。
use std::path::Path;

use globset::{GlobBuilder, GlobMatcher};

pub struct WorkspaceGlob {
    matcher: GlobMatcher,
}

pub fn compile(pattern: &str) -> Result<WorkspaceGlob, String> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err("pattern must not be empty".to_string());
    }
    let normalized = trimmed.replace('\\', "/");
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return Err("absolute pattern is not allowed".to_string());
    }
    if path
        .components()
        .any(|component| component == std::path::Component::ParentDir)
    {
        return Err("'..' is not allowed in pattern".to_string());
    }
    let effective = if normalized.contains('/') {
        normalized
    } else {
        format!("**/{normalized}")
    };
    let matcher = GlobBuilder::new(&effective)
        .literal_separator(true)
        .backslash_escape(false)
        .build()
        .map_err(|error| format!("invalid glob pattern: {error}"))?
        .compile_matcher();
    Ok(WorkspaceGlob { matcher })
}

impl WorkspaceGlob {
    pub fn is_match(&self, relative_path: &str) -> bool {
        self.matcher.is_match(relative_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_recursive_single_segment_and_extended_patterns() {
        let recursive = compile("**/*.ts").unwrap();
        assert!(recursive.is_match("a.ts"));
        assert!(recursive.is_match("src/deep/app.ts"));
        assert!(!recursive.is_match("src/app.js"));

        let basename = compile("*.ts").unwrap();
        assert!(basename.is_match("a.ts"));
        assert!(basename.is_match("src/deep/a.ts"));

        let extended = compile("**/*.{ts,tsx}").unwrap();
        assert!(extended.is_match("src/a.ts"));
        assert!(extended.is_match("src/a.tsx"));
        assert!(!extended.is_match("src/a.js"));
    }

    #[test]
    fn separator_keeps_directory_scope() {
        let matcher = compile("src/*.ts").unwrap();
        assert!(matcher.is_match("src/a.ts"));
        assert!(!matcher.is_match("src/sub/a.ts"));
        assert!(!matcher.is_match("a.ts"));
    }

    #[test]
    fn rejects_absolute_parent_empty_and_invalid_patterns() {
        assert!(compile("/abs/*.ts").is_err());
        assert!(compile("../*.ts").is_err());
        assert!(compile("  ").is_err());
        assert!(compile("[").is_err());
    }
}

//! 零依赖 glob 匹配：以 `/` 分段，`**` 跨段（含零段），`*`/`?` 仅段内。
//! 大小写敏感；不支持字符类与 `{a,b}` 展开，模型可组合多次调用弥补。
use std::path::Path;

/// 校验 pattern 是 workspace 相对路径形状（拒绝绝对路径与 `..`），返回分段。
pub fn pattern_segments(pattern: &str) -> Result<Vec<String>, String> {
    let trimmed = pattern.trim();
    if trimmed.is_empty() {
        return Err("pattern must not be empty".to_string());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err("absolute pattern is not allowed".to_string());
    }
    let mut segments = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                return Err("'..' is not allowed in pattern".to_string())
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err("path prefixes are not allowed in pattern".to_string())
            }
            std::path::Component::CurDir => continue,
            std::path::Component::Normal(part) => {
                segments.push(part.to_string_lossy().into_owned())
            }
        }
    }
    if segments.is_empty() {
        return Err("pattern must match at least one path segment".to_string());
    }
    Ok(segments)
}

/// 判断相对路径（分段形式）是否命中 pattern。
pub fn matches(pattern: &[String], segments: &[&str]) -> bool {
    let Some((first, rest)) = pattern.split_first() else {
        return segments.is_empty();
    };
    if first == "**" {
        // `**` 匹配零段或多段：先尝试吃掉零段，再逐段吃掉一层。
        if matches(rest, segments) {
            return true;
        }
        return !segments.is_empty() && matches(pattern, &segments[1..]);
    }
    let Some((head, tail)) = segments.split_first() else {
        return false;
    };
    match_segment(first, head) && matches(rest, tail)
}

/// 单段匹配：`*` 任意（不含 `/`，分段已保证）、`?` 单字符。
fn match_segment(pattern: &str, name: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let name: Vec<char> = name.chars().collect();
    let (mut p, mut n) = (0usize, 0usize);
    let (mut star, mut backtrack) = (None::<usize>, 0usize);
    while n < name.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == name[n]) {
            p += 1;
            n += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            backtrack = n;
            p += 1;
        } else if let Some(mark) = star {
            p = mark + 1;
            backtrack += 1;
            n = backtrack;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern(value: &str) -> Vec<String> {
        pattern_segments(value).unwrap()
    }

    #[test]
    fn matches_single_and_recursive_patterns() {
        let p = pattern("**/*.ts");
        assert!(matches(&p, &["a.ts"]));
        assert!(matches(&p, &["src", "app.ts"]));
        assert!(matches(&p, &["src", "deep", "app.ts"]));
        assert!(!matches(&p, &["src", "app.js"]));
    }

    #[test]
    fn star_does_not_cross_segments() {
        let p = pattern("src/*.ts");
        assert!(matches(&p, &["src", "a.ts"]));
        assert!(!matches(&p, &["src", "sub", "a.ts"]));
        assert!(!matches(&p, &["a.ts"]));
    }

    #[test]
    fn question_mark_and_exact_match() {
        let p = pattern("log-?.txt");
        assert!(matches(&p, &["log-1.txt"]));
        assert!(!matches(&p, &["log-12.txt"]));
        assert!(matches(&pattern("README.md"), &["README.md"]));
        assert!(!matches(&pattern("readme.md"), &["README.md"]));
    }

    #[test]
    fn rejects_absolute_parent_and_empty_patterns() {
        assert!(pattern_segments("/abs/*.ts").is_err());
        assert!(pattern_segments("../*.ts").is_err());
        assert!(pattern_segments("  ").is_err());
    }

    #[test]
    fn multi_star_pattern_with_trailing_double_star() {
        let p = pattern("docs/**");
        assert!(matches(&p, &["docs", "a.md"]));
        assert!(matches(&p, &["docs", "sub", "a.md"]));
        assert!(!matches(&p, &["a.md"]));
    }
}

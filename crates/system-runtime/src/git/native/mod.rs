//! In-process repository reads; no Git executable or external config includes.
use super::service::{BranchesOutcome, GitError};
use std::path::Path;

pub(super) fn failure(error: impl std::fmt::Display) -> GitError {
    GitError::new("git_failed", format!("repository read failed: {error}"))
}

pub(super) fn open(root: &Path) -> Result<Option<gix::Repository>, GitError> {
    match gix::discover_opts(
        root,
        Default::default(),
        gix::open::Options::default().permissions(gix::open::Permissions::isolated()),
    ) {
        Ok(repo) => Ok(Some(repo)),
        Err(gix::discover::Error::Discover(gix::discover::upwards::Error::NoGitRepository {
            ..
        })) => Ok(None),
        Err(error) => Err(failure(error)),
    }
}

pub(super) fn branches(root: &Path) -> Result<BranchesOutcome, GitError> {
    let Some(repo) = open(root)? else {
        return Ok(BranchesOutcome {
            repo: false,
            current: None,
            branches: vec![],
            remote_branches: vec![],
        });
    };
    let head = repo.head().map_err(failure)?;
    let current = head.referent_name().map(|name| name.shorten().to_string());
    let refs = repo.references().map_err(failure)?;
    let mut branches = Vec::new();
    let mut remote_branches = Vec::new();
    for reference in refs.all().map_err(failure)? {
        let reference = reference.map_err(failure)?;
        let name = reference.name().as_bstr().to_string();
        if let Some(name) = name.strip_prefix("refs/heads/") {
            branches.push(name.to_owned());
        }
        if let Some(name) = name.strip_prefix("refs/remotes/") {
            if !name.ends_with("/HEAD") {
                remote_branches.push(name.to_owned());
            }
        }
    }
    branches.sort();
    remote_branches.sort();
    Ok(BranchesOutcome {
        repo: true,
        current,
        branches,
        remote_branches,
    })
}

/// Resolve a blob from the index or a commit tree. Paths are relative to workspace cwd.
pub(super) fn blob(root: &Path, query: &str) -> Result<Option<Option<Vec<u8>>>, GitError> {
    let Some(repo) = open(root)? else {
        return Ok(None);
    };
    let (revision, relative) = query
        .split_once(":./")
        .ok_or_else(|| failure("invalid blob query"))?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| failure("bare repository has no working directory"))?
        .canonicalize()
        .map_err(failure)?;
    let absolute = root.canonicalize().map_err(failure)?.join(relative);
    let path = absolute.strip_prefix(&workdir).map_err(failure)?;
    let id = if revision.is_empty() {
        let Some(index) = repo.try_index().map_err(failure)? else {
            return Ok(Some(None));
        };
        let path = gix::path::to_unix_separators(
            gix::path::os_str_into_bstr(path.as_os_str()).map_err(failure)?,
        );
        let Some(offset) = index
            .entry_index_by_path_and_stage(path.as_ref(), gix::index::entry::Stage::Unconflicted)
        else {
            return Ok(Some(None));
        };
        index.entries()[offset].id
    } else {
        let commit = match repo.rev_parse_single(revision) {
            Ok(id) => id
                .object()
                .map_err(failure)?
                .try_into_commit()
                .map_err(failure)?,
            Err(_) => return Ok(Some(None)),
        };
        let tree = commit.tree().map_err(failure)?;
        let Some(entry) = tree.lookup_entry_by_path(path).map_err(failure)? else {
            return Ok(Some(None));
        };
        entry.id().detach()
    };
    let mut object = repo.find_object(id).map_err(failure)?;
    if object.kind != gix::objs::Kind::Blob {
        return Ok(Some(None));
    }
    Ok(Some(Some(std::mem::take(&mut object.data))))
}

#[cfg(test)]
mod tests;

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub(super) struct RotatingLog {
    directory: PathBuf,
    file: Option<File>,
    size: u64,
    max_bytes: u64,
    keep_files: usize,
}

impl RotatingLog {
    pub(super) fn new(directory: &Path, max_bytes: u64, keep_files: usize) -> io::Result<Self> {
        fs::create_dir_all(directory)?;
        let mut log = Self {
            directory: directory.to_path_buf(),
            file: None,
            size: 0,
            max_bytes: max_bytes.max(1),
            keep_files: keep_files.max(1),
        };
        // 配置减少保留数量时，也清理此前留下的更旧分段。
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let index = name
                .strip_prefix("studio.")
                .and_then(|name| name.strip_suffix(".log"))
                .and_then(|index| index.parse::<usize>().ok());
            if index.is_some_and(|index| index > 0 && index >= log.keep_files) {
                fs::remove_file(entry.path())?;
            }
        }
        log.open()?;
        Ok(log)
    }

    fn path(&self, index: usize) -> PathBuf {
        self.directory.join(if index == 0 {
            "studio.log".to_string()
        } else {
            format!("studio.{index}.log")
        })
    }

    fn open(&mut self) -> io::Result<()> {
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(self.path(0))?;
        self.size = file.metadata()?.len();
        self.file = Some(file);
        Ok(())
    }

    fn rotate(&mut self) -> io::Result<()> {
        // Windows 不允许重命名仍打开的日志文件。
        self.file.take();
        match fs::remove_file(self.path(self.keep_files - 1)) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        for index in (0..self.keep_files - 1).rev() {
            match fs::rename(self.path(index), self.path(index + 1)) {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                Err(error) => return Err(error),
            }
        }
        self.open()
    }

    pub(super) fn write(&mut self, line: &str) -> io::Result<()> {
        // 单条超大日志截断到 UTF-8 边界，任何一次写入都不突破文件大小上限。
        let mut end = line.len().min(self.max_bytes.saturating_sub(1) as usize);
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        let bytes = &line.as_bytes()[..end];
        if self.file.is_none() {
            self.open()?;
        }
        if self.size + bytes.len() as u64 + 1 > self.max_bytes {
            self.rotate()?;
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("log file unavailable"))?;
        let result = (|| {
            file.write_all(bytes)?;
            file.write_all(b"\n")?;
            file.flush()
        })();
        if let Err(error) = result {
            // 部分写入后重新打开并读取真实大小，防止恢复时突破大小上限。
            self.file.take();
            return Err(error);
        }
        self.size += bytes.len() as u64 + 1;
        Ok(())
    }
}

#[cfg(test)]
#[path = "rotation_tests.rs"]
mod tests;

//! Browser platform files. Retail bytes are immutable and shared with MIX views;
//! mutable profile/save writes commit synchronously to localStorage before success.
//! Storage quota/security failures are surfaced to the existing native UI owner.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::io::{self, ErrorKind};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

const PREFIX: &str = "vera20k.native.files.v1:";
const DIRECTORIES_KEY: &str = "vera20k.native.directories.v1";
pub const RETAIL_ROOT: &str = "/retail";

#[derive(Default)]
struct Files {
    assets: BTreeMap<String, Arc<Vec<u8>>>,
    persistent: BTreeMap<String, StoredFile>,
    mounted: bool,
    directories: BTreeSet<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct StoredFile {
    path: String,
    modified_ms: u64,
    base64: String,
}

thread_local! { static FILES: RefCell<Files> = RefCell::new(Files::default()); }

fn error(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}

fn key(path: &Path) -> io::Result<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            _ => {
                return Err(io::Error::new(
                    ErrorKind::InvalidInput,
                    "invalid browser file path",
                ));
            }
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

fn storage() -> io::Result<web_sys::Storage> {
    web_sys::window()
        .ok_or_else(|| error("browser file store requires a Window"))?
        .local_storage()
        .map_err(|e| error(format!("localStorage unavailable: {e:?}")))?
        .ok_or_else(|| error("localStorage is disabled"))
}

/// Called by the browser loader once per downloaded file. Consumes the Vec;
/// large MIX payloads are never converted to Arc<[u8]> or copied at mount time.
pub fn register_asset(name: &str, bytes: Vec<u8>) -> Result<(), String> {
    let relative = name.replace('\\', "/");
    if relative.starts_with('/') || relative.is_empty() {
        return Err("asset names must be nonempty relative paths".into());
    }
    let path = key(&Path::new(RETAIL_ROOT).join(relative)).map_err(|e| e.to_string())?;
    FILES.with(|files| {
        let mut files = files.borrow_mut();
        if files.mounted {
            return Err("retail files are already mounted".into());
        }
        let lookup = path.to_ascii_lowercase();
        if files.assets.contains_key(&lookup) {
            return Err(format!("duplicate retail file: {name}"));
        }
        files.assets.insert(lookup, Arc::new(bytes));
        Ok(())
    })
}

/// Hydrate durable user files before constructing the native App. Existing
/// browser data is authoritative over the read-only retail download catalog.
pub fn finish_mount_and_hydrate() -> Result<(), String> {
    let store = storage().map_err(|e| e.to_string())?;
    let directories: BTreeSet<String> = match store
        .get_item(DIRECTORIES_KEY)
        .map_err(|e| format!("storage directory read: {e:?}"))?
    {
        None => BTreeSet::new(),
        Some(text) => {
            serde_json::from_str(&text).map_err(|e| format!("invalid browser directories: {e}"))?
        }
    };
    for path in &directories {
        if key(Path::new(path))
            .map_err(|e| e.to_string())?
            .to_ascii_lowercase()
            != *path
        {
            return Err(format!("invalid persisted directory: {path}"));
        }
    }
    let mut hydrated = BTreeMap::new();
    for index in 0..store
        .length()
        .map_err(|e| format!("storage length: {e:?}"))?
    {
        let Some(name) = store
            .key(index)
            .map_err(|e| format!("storage key: {e:?}"))?
        else {
            continue;
        };
        let Some(path) = name.strip_prefix(PREFIX) else {
            continue;
        };
        let value = store
            .get_item(&name)
            .map_err(|e| format!("storage read: {e:?}"))?
            .ok_or_else(|| format!("browser file disappeared: {path}"))?;
        let file: StoredFile = serde_json::from_str(&value)
            .map_err(|e| format!("invalid persisted file {path}: {e}"))?;
        if key(Path::new(&file.path))
            .map_err(|e| e.to_string())?
            .to_ascii_lowercase()
            != path
        {
            return Err(format!("invalid persisted path: {path}"));
        }
        crate::util::base64::base64_decode(&file.base64)
            .map_err(|e| format!("invalid persisted bytes {path}: {e}"))?;
        hydrated.insert(path.to_string(), file);
    }
    FILES.with(|files| {
        let mut files = files.borrow_mut();
        if files.mounted {
            return Err("browser file store is already mounted".into());
        }
        files.persistent = hydrated;
        files.directories = directories;
        files.mounted = true;
        Ok(())
    })
}

pub fn read_shared(path: impl AsRef<Path>) -> io::Result<Arc<Vec<u8>>> {
    let path = key(path.as_ref())?.to_ascii_lowercase();
    FILES.with(|files| {
        let files = files.borrow();
        if let Some(file) = files.persistent.get(&path) {
            return crate::util::base64::base64_decode(&file.base64)
                .map(Arc::new)
                .map_err(error);
        }
        files
            .assets
            .get(&path)
            .cloned()
            .ok_or_else(|| io::Error::new(ErrorKind::NotFound, path))
    })
}

pub fn read(path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    Ok(read_shared(path)?.as_ref().clone())
}
pub fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
    String::from_utf8(read(path)?).map_err(|e| io::Error::new(ErrorKind::InvalidData, e))
}

fn encode(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let bits = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        for shift in [18, 12] {
            result.push(ABC[((bits >> shift) & 63) as usize] as char);
        }
        result.push(if chunk.len() > 1 {
            ABC[((bits >> 6) & 63) as usize] as char
        } else {
            '='
        });
        result.push(if chunk.len() > 2 {
            ABC[(bits & 63) as usize] as char
        } else {
            '='
        });
    }
    result
}

pub fn write(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) -> io::Result<()> {
    let path = key(path.as_ref())?;
    let lookup = path.to_ascii_lowercase();
    FILES.with(|files| {
        let files = files.borrow();
        if !files.mounted {
            return Err(error("browser file store has not been hydrated"));
        }
        if files.assets.contains_key(&lookup) {
            return Err(io::Error::new(
                ErrorKind::PermissionDenied,
                "downloaded retail assets are read-only",
            ));
        }
        Ok(())
    })?;
    let file = StoredFile {
        path,
        modified_ms: js_sys::Date::now() as u64,
        base64: encode(bytes.as_ref()),
    };
    let serialized = serde_json::to_string(&file).map_err(|e| error(e.to_string()))?;
    storage()?
        .set_item(&format!("{PREFIX}{lookup}"), &serialized)
        .map_err(|e| {
            error(format!(
                "could not commit browser file (storage quota or permission): {e:?}"
            ))
        })?;
    FILES.with(|files| files.borrow_mut().persistent.insert(lookup, file));
    Ok(())
}

pub fn write_new(path: impl AsRef<Path>, bytes: &[u8]) -> io::Result<()> {
    if metadata(path.as_ref()).is_ok() {
        return Err(io::Error::new(
            ErrorKind::AlreadyExists,
            "browser file already exists",
        ));
    }
    write(path, bytes)
}

pub fn remove_file(path: impl AsRef<Path>) -> io::Result<()> {
    let lookup = key(path.as_ref())?.to_ascii_lowercase();
    let exists = FILES.with(|files| files.borrow().persistent.contains_key(&lookup));
    if !exists {
        return Err(io::Error::new(ErrorKind::NotFound, lookup));
    }
    storage()?
        .remove_item(&format!("{PREFIX}{lookup}"))
        .map_err(|e| error(format!("storage delete: {e:?}")))?;
    FILES.with(|files| files.borrow_mut().persistent.remove(&lookup));
    Ok(())
}

pub fn rename(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
    // SaveRepository uses an atomic single-key replacement on Web instead of
    // this two-key operation. Other native callers may use ordinary rename.
    let bytes = read(from.as_ref())?;
    write(to, bytes)?;
    remove_file(from)
}

pub fn create_dir(path: impl AsRef<Path>) -> io::Result<()> {
    if metadata(path.as_ref()).is_ok() {
        return Err(io::Error::new(
            ErrorKind::AlreadyExists,
            "browser directory already exists",
        ));
    }
    create_dir_all(path)
}
pub fn create_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
    let path = PathBuf::from(key(path.as_ref())?.to_ascii_lowercase());
    if metadata(&path).is_ok_and(|m| m.is_dir()) {
        return Ok(());
    }
    let mut directories = FILES.with(|files| files.borrow().directories.clone());
    for ancestor in path.ancestors() {
        if metadata(ancestor).is_ok_and(|m| m.is_file()) {
            return Err(io::Error::new(
                ErrorKind::NotADirectory,
                "browser directory parent is a file",
            ));
        }
        directories.insert(key(ancestor)?);
    }
    let encoded = serde_json::to_string(&directories).map_err(|e| error(e.to_string()))?;
    storage()?
        .set_item(DIRECTORIES_KEY, &encoded)
        .map_err(|e| error(format!("storage directory commit: {e:?}")))?;
    FILES.with(|files| files.borrow_mut().directories = directories);
    Ok(())
}

#[derive(Clone)]
pub struct Metadata {
    file: bool,
    modified_ms: u64,
    len: u64,
}
impl Metadata {
    pub fn is_file(&self) -> bool {
        self.file
    }
    pub fn is_dir(&self) -> bool {
        !self.file
    }
    pub fn len(&self) -> u64 {
        self.len
    }
    pub fn modified(&self) -> io::Result<web_time::SystemTime> {
        Ok(web_time::UNIX_EPOCH + web_time::Duration::from_millis(self.modified_ms))
    }
}

pub fn metadata(path: impl AsRef<Path>) -> io::Result<Metadata> {
    let lookup = key(path.as_ref())?.to_ascii_lowercase();
    FILES.with(|files| {
        let files = files.borrow();
        if let Some(file) = files.persistent.get(&lookup) {
            return Ok(Metadata {
                file: true,
                modified_ms: file.modified_ms,
                len: (file.base64.len() / 4 * 3)
                    .saturating_sub(file.base64.bytes().rev().take_while(|b| *b == b'=').count())
                    as u64,
            });
        }
        if let Some(bytes) = files.assets.get(&lookup) {
            return Ok(Metadata {
                file: true,
                modified_ms: 0,
                len: bytes.len() as u64,
            });
        }
        let prefix = format!("{lookup}/");
        if lookup == "/"
            || lookup == "/retail"
            || lookup == "/settings"
            || lookup == "/saves"
            || files.directories.contains(&lookup)
            || files
                .assets
                .keys()
                .chain(files.persistent.keys())
                .any(|p| p.starts_with(&prefix))
        {
            return Ok(Metadata {
                file: false,
                modified_ms: 0,
                len: 0,
            });
        }
        Err(io::Error::new(ErrorKind::NotFound, lookup))
    })
}

pub struct DirEntry {
    path: PathBuf,
}
impl DirEntry {
    pub fn path(&self) -> PathBuf {
        self.path.clone()
    }
    pub fn file_name(&self) -> OsString {
        self.path.file_name().unwrap_or_default().to_owned()
    }
    pub fn metadata(&self) -> io::Result<Metadata> {
        metadata(&self.path)
    }
}

pub fn read_dir(path: impl AsRef<Path>) -> io::Result<std::vec::IntoIter<io::Result<DirEntry>>> {
    let directory = key(path.as_ref())?.to_ascii_lowercase();
    if !metadata(Path::new(&directory))?.is_dir() {
        return Err(io::Error::new(ErrorKind::NotADirectory, directory));
    }
    let prefix = format!("{}/", directory.trim_end_matches('/'));
    let entries = FILES.with(|files| {
        let files = files.borrow();
        let mut paths = BTreeMap::new();
        for p in files
            .assets
            .keys()
            .chain(files.persistent.keys())
            .chain(files.directories.iter())
        {
            if let Some(relative) = p.strip_prefix(&prefix) {
                let first = relative.split('/').next().unwrap_or_default();
                if !first.is_empty() {
                    paths.insert(format!("{prefix}{first}"), ());
                }
            }
        }
        paths
            .into_keys()
            .map(|p| {
                Ok(DirEntry {
                    path: PathBuf::from(p),
                })
            })
            .collect::<Vec<_>>()
    });
    Ok(entries.into_iter())
}

/// Narrow ANSI-file adapter for the existing random-map seed owner. Writes
/// acknowledge the same durable per-file transaction as profile/save writes.
pub struct BrowserFile {
    path: PathBuf,
    cursor: io::Cursor<Vec<u8>>,
    writable: bool,
}
impl BrowserFile {
    pub fn open(path: PathBuf, writable: bool) -> io::Result<Self> {
        let bytes = if writable {
            write(&path, [])?;
            Vec::new()
        } else {
            read(&path)?
        };
        Ok(Self {
            path,
            cursor: io::Cursor::new(bytes),
            writable,
        })
    }
}
impl io::Read for BrowserFile {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        io::Read::read(&mut self.cursor, bytes)
    }
}
impl io::Write for BrowserFile {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if !self.writable {
            return Err(io::Error::new(
                ErrorKind::PermissionDenied,
                "file opened read-only",
            ));
        }
        let mut candidate = self.cursor.clone();
        let count = io::Write::write(&mut candidate, bytes)?;
        write(&self.path, candidate.get_ref())?;
        self.cursor = candidate;
        Ok(count)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

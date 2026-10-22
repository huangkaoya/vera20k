//! Durable browser-file namespace migration. Values stay byte-for-byte intact;
//! parsing and validation belong to the existing browser file owner.

use std::collections::{BTreeMap, BTreeSet};

pub(super) const PREFIX: &str = "werhd.native.files.v1:";
pub(super) const DIRECTORIES_KEY: &str = "werhd.native.directories.v1";
const LEGACY_PREFIX: &str = "vera20k.native.files.v1:";
const LEGACY_DIRECTORIES_KEY: &str = "vera20k.native.directories.v1";

pub(super) trait Store {
    type Error;

    fn keys(&self) -> Result<Vec<String>, Self::Error>;
    fn read(&self, key: &str) -> Result<Option<String>, Self::Error>;
    fn write(&self, key: &str, value: &str) -> Result<(), Self::Error>;
    fn remove(&self, key: &str) -> Result<(), Self::Error>;
}

fn read_and_migrate<S: Store>(
    store: &S,
    current: &str,
    legacy: &str,
) -> Result<Option<String>, S::Error> {
    if let Some(value) = store.read(current)? {
        return Ok(Some(value));
    }
    let value = store.read(legacy)?;
    if let Some(value) = &value {
        // Quota/security failures must not make an existing profile or save
        // unreadable. Delete the old key only after the replacement committed.
        if store.write(current, value).is_ok() {
            let _ = store.remove(legacy);
        }
    }
    Ok(value)
}

pub(super) fn read_directories<S: Store>(store: &S) -> Result<Option<String>, S::Error> {
    read_and_migrate(store, DIRECTORIES_KEY, LEGACY_DIRECTORIES_KEY)
}

pub(super) fn read_files<S: Store>(store: &S) -> Result<BTreeMap<String, String>, S::Error> {
    // Snapshot all names before moving any key. Removing localStorage entries
    // while enumerating numeric indexes would skip subsequent saves/settings.
    let paths: BTreeSet<_> = store
        .keys()?
        .iter()
        .filter_map(|name| {
            name.strip_prefix(PREFIX)
                .or_else(|| name.strip_prefix(LEGACY_PREFIX))
                .map(str::to_owned)
        })
        .collect();
    let mut files = BTreeMap::new();
    for path in paths {
        if let Some(value) = read_and_migrate(
            store,
            &format!("{PREFIX}{path}"),
            &format!("{LEGACY_PREFIX}{path}"),
        )? {
            files.insert(path, value);
        }
    }
    Ok(files)
}

pub(super) fn write_file<S: Store>(store: &S, path: &str, value: &str) -> Result<(), S::Error> {
    store.write(&format!("{PREFIX}{path}"), value)?;
    // A prior migration may have fallen back to the legacy value. Retire that
    // value only after this ordinary write has durably replaced it.
    let _ = store.remove(&format!("{LEGACY_PREFIX}{path}"));
    Ok(())
}

pub(super) fn write_directories<S: Store>(store: &S, value: &str) -> Result<(), S::Error> {
    store.write(DIRECTORIES_KEY, value)?;
    let _ = store.remove(LEGACY_DIRECTORIES_KEY);
    Ok(())
}

pub(super) fn remove_file<S: Store>(store: &S, path: &str) -> Result<(), S::Error> {
    // Remove a stale/fallback legacy copy first. A failed legacy deletion must
    // retain the current file, rather than resurrect the old save next launch.
    store.remove(&format!("{LEGACY_PREFIX}{path}"))?;
    store.remove(&format!("{PREFIX}{path}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct MemoryStore {
        values: RefCell<BTreeMap<String, String>>,
        blocked_writes: RefCell<BTreeSet<String>>,
        blocked_removes: RefCell<BTreeSet<String>>,
        writes: RefCell<Vec<String>>,
    }

    impl Store for MemoryStore {
        type Error = &'static str;

        fn keys(&self) -> Result<Vec<String>, Self::Error> {
            Ok(self.values.borrow().keys().cloned().collect())
        }
        fn read(&self, key: &str) -> Result<Option<String>, Self::Error> {
            Ok(self.values.borrow().get(key).cloned())
        }
        fn write(&self, key: &str, value: &str) -> Result<(), Self::Error> {
            self.writes.borrow_mut().push(key.to_owned());
            if self.blocked_writes.borrow().contains(key) {
                return Err("storage quota or permission");
            }
            self.values.borrow_mut().insert(key.into(), value.into());
            Ok(())
        }
        fn remove(&self, key: &str) -> Result<(), Self::Error> {
            if self.blocked_removes.borrow().contains(key) {
                return Err("storage permission");
            }
            self.values.borrow_mut().remove(key);
            Ok(())
        }
    }

    fn legacy_store() -> (MemoryStore, BTreeMap<String, String>) {
        let files: BTreeMap<_, _> = [
            ("/settings/ra2md.ini", "profile:MouseSensitivityPercent=175"),
            (
                "/settings/ios-shortcuts.json",
                "shortcuts:[ForceAttack,Stop]",
            ),
            ("/saves/savegame.sav", "save:VERA20K\\0:AAEC/w=="),
        ]
        .into_iter()
        .map(|(path, bytes)| (path.to_owned(), bytes.to_owned()))
        .collect();
        let store = MemoryStore::default();
        for (path, bytes) in &files {
            store
                .values
                .borrow_mut()
                .insert(format!("{LEGACY_PREFIX}{path}"), bytes.clone());
        }
        store.values.borrow_mut().insert(
            LEGACY_DIRECTORIES_KEY.into(),
            "[\"/settings\",\"/saves\",\"/empty\"]".into(),
        );
        store
            .values
            .borrow_mut()
            .insert("unrelated.application".into(), "untouched".into());
        (store, files)
    }

    #[test]
    fn migrates_all_settings_shortcuts_saves_and_directories_without_changing_values() {
        let (store, files) = legacy_store();
        let directories = store.read(LEGACY_DIRECTORIES_KEY).unwrap();
        assert_eq!(read_directories(&store).unwrap(), directories);
        assert_eq!(read_files(&store).unwrap(), files);
        assert_eq!(store.read(DIRECTORIES_KEY).unwrap(), directories);
        for (path, bytes) in &files {
            assert_eq!(
                store.read(&format!("{PREFIX}{path}")).unwrap(),
                Some(bytes.clone())
            );
            assert_eq!(store.read(&format!("{LEGACY_PREFIX}{path}")).unwrap(), None);
        }
        assert_eq!(store.read(LEGACY_DIRECTORIES_KEY).unwrap(), None);
        assert_eq!(
            store.read("unrelated.application").unwrap().as_deref(),
            Some("untouched")
        );
    }

    #[test]
    fn existing_current_file_and_directory_values_always_win_without_overwrite() {
        let (store, mut files) = legacy_store();
        let path = "/settings/ra2md.ini";
        store
            .values
            .borrow_mut()
            .insert(format!("{PREFIX}{path}"), "newer profile".into());
        store
            .values
            .borrow_mut()
            .insert(DIRECTORIES_KEY.into(), "[\"/newer\"]".into());
        files.insert(path.into(), "newer profile".into());
        assert_eq!(
            read_directories(&store).unwrap().as_deref(),
            Some("[\"/newer\"]")
        );
        assert_eq!(read_files(&store).unwrap(), files);
        assert!(!store.writes.borrow().contains(&format!("{PREFIX}{path}")));
        assert!(
            !store
                .writes
                .borrow()
                .iter()
                .any(|key| key == DIRECTORIES_KEY)
        );
        assert!(
            store
                .read(&format!("{LEGACY_PREFIX}{path}"))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn blocked_migration_retains_legacy_values_and_reads_them_until_retry_succeeds() {
        let (store, files) = legacy_store();
        let directories = store.read(LEGACY_DIRECTORIES_KEY).unwrap();
        store
            .blocked_writes
            .borrow_mut()
            .extend(files.keys().map(|path| format!("{PREFIX}{path}")));
        store
            .blocked_writes
            .borrow_mut()
            .insert(DIRECTORIES_KEY.into());
        for _ in 0..2 {
            assert_eq!(read_directories(&store).unwrap(), directories);
            assert_eq!(read_files(&store).unwrap(), files);
            for (path, bytes) in &files {
                assert_eq!(
                    store.read(&format!("{LEGACY_PREFIX}{path}")).unwrap(),
                    Some(bytes.clone())
                );
                assert_eq!(store.read(&format!("{PREFIX}{path}")).unwrap(), None);
            }
            assert_eq!(store.read(LEGACY_DIRECTORIES_KEY).unwrap(), directories);
        }
        store.blocked_writes.borrow_mut().clear();
        assert_eq!(read_directories(&store).unwrap(), directories);
        assert_eq!(read_files(&store).unwrap(), files);
        assert_eq!(store.read(LEGACY_DIRECTORIES_KEY).unwrap(), None);
        assert!(
            store
                .keys()
                .unwrap()
                .iter()
                .all(|key| !key.starts_with(LEGACY_PREFIX))
        );
    }

    #[test]
    fn later_write_retires_fallback_only_after_successful_current_commit() {
        let (store, _) = legacy_store();
        let path = "/settings/ios-shortcuts.json";
        let legacy_key = format!("{LEGACY_PREFIX}{path}");
        let current_key = format!("{PREFIX}{path}");
        let old = store.read(&legacy_key).unwrap();
        store
            .blocked_writes
            .borrow_mut()
            .insert(current_key.clone());
        assert!(write_file(&store, path, "new shortcuts").is_err());
        assert_eq!(store.read(&legacy_key).unwrap(), old);
        assert_eq!(store.read(&current_key).unwrap(), None);
        store.blocked_writes.borrow_mut().clear();
        write_file(&store, path, "new shortcuts").unwrap();
        assert_eq!(
            store.read(&current_key).unwrap().as_deref(),
            Some("new shortcuts")
        );
        assert_eq!(store.read(&legacy_key).unwrap(), None);
    }

    #[test]
    fn failed_legacy_cleanup_keeps_current_authoritative_and_delete_cannot_resurrect_old_save() {
        let (store, _) = legacy_store();
        let path = "/saves/savegame.sav";
        let legacy_key = format!("{LEGACY_PREFIX}{path}");
        let current_key = format!("{PREFIX}{path}");
        store
            .blocked_removes
            .borrow_mut()
            .insert(legacy_key.clone());
        read_files(&store).unwrap();
        write_file(&store, path, "updated save").unwrap();
        assert_eq!(
            read_files(&store).unwrap().get(path).map(String::as_str),
            Some("updated save")
        );
        assert!(store.read(&legacy_key).unwrap().is_some());
        assert!(remove_file(&store, path).is_err());
        assert_eq!(
            store.read(&current_key).unwrap().as_deref(),
            Some("updated save")
        );
        store.blocked_removes.borrow_mut().clear();
        remove_file(&store, path).unwrap();
        assert!(!read_files(&store).unwrap().contains_key(path));
        assert_eq!(store.read(&legacy_key).unwrap(), None);
        assert_eq!(store.read(&current_key).unwrap(), None);
    }

    #[test]
    fn directory_updates_keep_legacy_until_commit_and_fallback_save_can_be_deleted() {
        let (store, _) = legacy_store();
        let old = store.read(LEGACY_DIRECTORIES_KEY).unwrap();
        store
            .blocked_writes
            .borrow_mut()
            .insert(DIRECTORIES_KEY.into());
        assert!(write_directories(&store, "[\"/replacement\"]").is_err());
        assert_eq!(store.read(LEGACY_DIRECTORIES_KEY).unwrap(), old);
        store.blocked_writes.borrow_mut().clear();
        write_directories(&store, "[\"/replacement\"]").unwrap();
        assert_eq!(
            store.read(DIRECTORIES_KEY).unwrap().as_deref(),
            Some("[\"/replacement\"]")
        );
        assert_eq!(store.read(LEGACY_DIRECTORIES_KEY).unwrap(), None);
        remove_file(&store, "/saves/savegame.sav").unwrap();
        assert!(
            !read_files(&store)
                .unwrap()
                .contains_key("/saves/savegame.sav")
        );
    }
}

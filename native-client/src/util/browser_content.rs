//! Browser content admission, independent of a lobby or resource downloader.
//!
//! JavaScript verifies and mounts a selected content set before starting VERA.
//! This capability receipt is then immutable for that native instance. It does
//! not grant writes to the retail provider or change any simulation rules.

use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentCapabilities {
    pub schema: u8,
    #[serde(default)]
    pub campaign: bool,
    #[serde(default)]
    pub movies: bool,
    #[serde(default)]
    pub music: bool,
    #[serde(default)]
    pub menu_animation: bool,
}

impl Default for ContentCapabilities {
    fn default() -> Self {
        Self {
            schema: 1,
            campaign: false,
            movies: false,
            music: false,
            menu_animation: false,
        }
    }
}

impl ContentCapabilities {
    /// Native installs retain their existing media requirements and playback.
    pub const FULL: Self = Self {
        schema: 1,
        campaign: true,
        movies: true,
        music: true,
        menu_animation: true,
    };

    pub fn parse(json: &str) -> Result<Self, String> {
        if json.len() > 4096 {
            return Err("browser content configuration exceeds four KiB".into());
        }
        let value: Self = serde_json::from_str(json)
            .map_err(|error| format!("invalid browser content configuration: {error}"))?;
        if value.schema != 1 {
            return Err("unsupported browser content configuration schema".into());
        }
        Ok(value)
    }
}

#[cfg(any(target_arch = "wasm32", test))]
#[derive(Default)]
struct Admission {
    capabilities: ContentCapabilities,
    frozen: bool,
}

#[cfg(any(target_arch = "wasm32", test))]
impl Admission {
    fn configure(&mut self, json: &str) -> Result<(), String> {
        if self.frozen {
            return Err("browser content capabilities are frozen after startup".into());
        }
        self.capabilities = ContentCapabilities::parse(json)?;
        Ok(())
    }

    fn freeze(&mut self) {
        self.frozen = true;
    }
}

#[cfg(target_arch = "wasm32")]
thread_local! {
    static ADMISSION: std::cell::RefCell<Admission> =
        std::cell::RefCell::new(Admission::default());
}

#[cfg(target_arch = "wasm32")]
pub fn configure(json: &str) -> Result<(), String> {
    ADMISSION.with(|state| state.borrow_mut().configure(json))
}

#[cfg(target_arch = "wasm32")]
pub fn freeze() {
    ADMISSION.with(|state| state.borrow_mut().freeze());
}

pub fn capabilities() -> ContentCapabilities {
    #[cfg(target_arch = "wasm32")]
    {
        ADMISSION.with(|state| state.borrow().capabilities)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        ContentCapabilities::FULL
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skirmish_default_is_media_free_and_capabilities_freeze_at_startup() {
        let mut admission = Admission::default();
        assert_eq!(admission.capabilities, ContentCapabilities::default());
        admission
            .configure(r#"{"schema":1,"campaign":true,"menuAnimation":true}"#)
            .unwrap();
        assert!(admission.capabilities.campaign);
        assert!(admission.capabilities.menu_animation);
        assert!(!admission.capabilities.movies);
        admission.freeze();
        let frozen = admission.capabilities;
        assert!(admission.configure(r#"{"schema":1}"#).is_err());
        assert_eq!(admission.capabilities, frozen);
    }

    #[test]
    fn invalid_configuration_does_not_replace_an_admitted_profile() {
        let mut admission = Admission::default();
        admission.configure(r#"{"schema":1,"music":true}"#).unwrap();
        let previous = admission.capabilities;
        for invalid in [
            r#"{"schema":2}"#,
            r#"{"schema":1,"music":"yes"}"#,
            r#"{"schema":1,"unknown":true}"#,
            r#"{"campaign":true}"#,
        ] {
            assert!(admission.configure(invalid).is_err());
            assert_eq!(admission.capabilities, previous);
        }
    }
}

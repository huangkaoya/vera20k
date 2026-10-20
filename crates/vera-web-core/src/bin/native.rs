//! Native oracle for exactly the same JSON dispatcher and asset policy as the worker.
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use vera_web_core::Engine;
fn include(name: &str) -> bool {
    static POLICY: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    let policy = POLICY.get_or_init(|| {
        serde_json::from_str(include_str!("../../../../tools/retail-policy.json"))
            .expect("checked-in retail policy")
    });
    let n = name.to_ascii_lowercase();
    let listed = |key: &str| {
        policy[key]
            .as_array()
            .expect("policy array")
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>()
    };
    !listed("exclude").contains(&n.as_str())
        && (listed("names").contains(&n.as_str())
            || n.ends_with(".mix")
                && listed("mixPrefixes")
                    .iter()
                    .any(|prefix| n.starts_with(prefix))
            || listed("extensions").iter().any(|ext| n.ends_with(ext)))
}

fn assets(engine: &mut Engine, root: &Path) -> Result<(), String> {
    let mut files: Vec<_> = std::fs::read_dir(root)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| e.path().is_file() && include(&e.file_name().to_string_lossy()))
        .collect();
    files.sort_by_key(|e| e.file_name());
    for file in files {
        engine.asset(
            file.file_name().to_string_lossy().into_owned(),
            std::fs::read(file.path()).map_err(|e| e.to_string())?,
        )?;
    }
    Ok(())
}
fn main() -> Result<(), String> {
    let mut argv = std::env::args().skip(1);
    let mut root = None;
    let mut script = None;
    let mut hashes = false;
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--assets" => root = Some(PathBuf::from(argv.next().ok_or("--assets needs a root")?)),
            "--script" => script = Some(PathBuf::from(argv.next().ok_or("--script needs a path")?)),
            "--hashes" => hashes = true,
            _ => return Err(format!("unknown option {arg}")),
        }
    }
    let mut engine = Engine::new();
    assets(
        &mut engine,
        &root.ok_or("--assets <retail-root> is required")?,
    )?;
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    let mut call = |input: &str| -> Result<(), String> {
        let response = engine.call(input);
        if hashes {
            let v: serde_json::Value =
                serde_json::from_str(&response).map_err(|e| e.to_string())?;
            let summary = if v["ok"] == true {
                serde_json::json!({"ok":true,"tick":v["snapshot"]["tick"],"stateHash":v["snapshot"]["stateHash"]})
            } else {
                v
            };
            writeln!(output, "{summary}").map_err(|e| e.to_string())?;
        } else {
            writeln!(output, "{response}").map_err(|e| e.to_string())?;
        }
        output.flush().map_err(|e| e.to_string())
    };
    if let Some(path) = script {
        let values: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        for v in values {
            call(&v.to_string())?;
        }
    } else {
        for line in std::io::stdin().lock().lines() {
            let line = line.map_err(|e| e.to_string())?;
            if !line.trim().is_empty() {
                call(&line)?;
            }
        }
    }
    Ok(())
}

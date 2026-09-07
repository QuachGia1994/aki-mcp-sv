// Aki Watch backend. Every command that waits on a subprocess runs on spawn_blocking
// so a slow Node/Python child never freezes the window (RULE-stack-tauri A1).
// Automation, config and Telegram transport live in the repo's scripts/postman-pool*;
// this app only orchestrates them, so no join/report/config logic is reimplemented here.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn repo_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("AKI_WATCH_REPO_DIR") {
        return PathBuf::from(dir);
    }
    // apps/aki-watch/src-tauri -> repo root (three levels up). Baked at build time;
    // a shared build on another machine can override it with AKI_WATCH_REPO_DIR.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn config_path() -> PathBuf {
    // Mirror scripts/userdata.js: ~/.aki/mcpsv/postman-pool.json.
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home)
        .join(".aki")
        .join("mcpsv")
        .join("postman-pool.json")
}

fn setup_script() -> PathBuf {
    repo_dir().join("scripts").join("postman-pool-setup.js")
}

fn telegram_script() -> PathBuf {
    repo_dir().join("scripts").join("postman-pool-telegram.py")
}

fn run_node_io(args: &[&str], stdin_data: Option<&str>) -> Result<String, String> {
    let repo = repo_dir();
    let script = setup_script();
    let mut command = Command::new("node");
    command
        .arg(&script)
        .args(args)
        .current_dir(&repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if stdin_data.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to run node ({}): {}", script.display(), e))?;
    if let Some(data) = stdin_data {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to open node stdin".to_string())?;
        stdin
            .write_all(data.as_bytes())
            .map_err(|e| format!("failed to write node stdin: {}", e))?;
        // Dropping stdin closes the pipe so the child sees EOF.
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("failed to wait for node: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if output.status.success() {
        Ok(stdout)
    } else if stderr.trim().is_empty() {
        Err(stdout)
    } else {
        Err(stderr)
    }
}

// Capture the Telegram transport script's output (e.g. --list-dialogs). -X utf8 keeps
// emoji-titled groups from crashing the Windows console codec.
fn run_py_capture(args: &[&str]) -> Result<String, String> {
    let repo = repo_dir();
    let script = telegram_script();
    let cfg = config_path();
    let output = Command::new("py")
        .arg("-3")
        .arg("-X")
        .arg("utf8")
        .arg(&script)
        .args(args)
        .arg("--config")
        .arg(&cfg)
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("failed to run py ({}): {}", script.display(), e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if output.status.success() {
        Ok(stdout)
    } else if stderr.trim().is_empty() {
        Err(stdout)
    } else {
        Err(stderr)
    }
}

// Open the interactive Telegram flows (login / observe-senders) in their own console
// so the owner can type phone/OTP/2FA. Fire-and-forget: the console outlives this call.
#[cfg(windows)]
fn spawn_py_console(args: &[&str]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    let repo = repo_dir();
    let script = telegram_script();
    let cfg = config_path();
    Command::new("py")
        .arg("-3")
        .arg("-X")
        .arg("utf8")
        .arg(&script)
        .args(args)
        .arg("--config")
        .arg(&cfg)
        .current_dir(&repo)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map_err(|e| format!("failed to open console: {}", e))?;
    Ok("Opened a console window. Complete the prompts there, then return here.".to_string())
}

#[cfg(not(windows))]
fn spawn_py_console(_args: &[&str]) -> Result<String, String> {
    Err("Console launch is only supported on Windows.".to_string())
}

async fn node_command(args: Vec<String>, stdin_data: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_node_io(&arg_refs, stdin_data.as_deref())
    })
    .await
    .map_err(|e| format!("spawn_blocking panicked: {}", e))?
}

async fn py_capture(args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_py_capture(&arg_refs)
    })
    .await
    .map_err(|e| format!("spawn_blocking panicked: {}", e))?
}

async fn py_console(args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        spawn_py_console(&arg_refs)
    })
    .await
    .map_err(|e| format!("spawn_blocking panicked: {}", e))?
}

#[tauri::command]
async fn env_check() -> Result<String, String> {
    node_command(vec!["--check".into()], None).await
}

#[tauri::command]
async fn config_status() -> Result<String, String> {
    node_command(vec!["--status-json".into()], None).await
}

#[tauri::command]
async fn get_config() -> Result<String, String> {
    node_command(vec!["--get-config-json".into()], None).await
}

#[tauri::command]
async fn save_config(patch: String) -> Result<String, String> {
    node_command(vec!["--set-config-json".into()], Some(patch)).await
}

#[tauri::command]
async fn send_test() -> Result<String, String> {
    node_command(vec!["--send-test-json".into()], None).await
}

#[tauri::command]
async fn list_dialogs() -> Result<String, String> {
    py_capture(vec!["--list-dialogs".into()]).await
}

#[tauri::command]
async fn launch_login() -> Result<String, String> {
    py_console(vec!["--login".into()]).await
}

#[tauri::command]
async fn launch_observe() -> Result<String, String> {
    py_console(vec!["--observe-senders".into()]).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            env_check,
            config_status,
            get_config,
            save_config,
            send_test,
            list_dialogs,
            launch_login,
            launch_observe
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

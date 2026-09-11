// Aki Watch backend. Every command that waits on a subprocess runs on spawn_blocking
// so a slow Node/Python child never freezes the window (RULE-stack-tauri A1).
// Automation, config and Telegram transport live in the repo's scripts/postman-pool*;
// this app only orchestrates them, so no join/report/config logic is reimplemented here.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use tauri::Manager;

static BUNDLED_RUNTIME_DIR: OnceLock<PathBuf> = OnceLock::new();

fn has_runtime_scripts(root: &Path) -> bool {
    root.join("package.json").is_file()
        && root
            .join("scripts")
            .join("postman-pool-control.js")
            .is_file()
        && root.join("scripts").join("postman-pool.js").is_file()
        && root.join("scripts").join("postman-pool-setup.js").is_file()
        && root.join("scripts").join("postman-pool-join.py").is_file()
        && root
            .join("scripts")
            .join("postman-pool-telegram.py")
            .is_file()
        && root.join("scripts").join("userdata.js").is_file()
}

#[cfg(windows)]
fn child_process_path(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path;
    };
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", rest));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

#[cfg(not(windows))]
fn child_process_path(path: PathBuf) -> PathBuf {
    path
}

fn canonical_child_path(path: PathBuf) -> Option<PathBuf> {
    path.canonicalize().ok().map(child_process_path)
}

fn canonical_runtime_dir(root: PathBuf) -> Option<PathBuf> {
    let root = canonical_child_path(root)?;
    has_runtime_scripts(&root).then_some(root)
}

fn repo_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("AKI_WATCH_REPO_DIR") {
        if let Some(root) = canonical_runtime_dir(PathBuf::from(dir)) {
            return root;
        }
    }
    if let Some(root) = BUNDLED_RUNTIME_DIR.get() {
        if let Some(root) = canonical_runtime_dir(root.clone()) {
            return root;
        }
    }
    // A no-install Windows build keeps aki-watch-runtime directly beside aki-watch.exe.
    // Resolve this independently of Tauri's resource_dir so portable launches do not depend
    // on installer-style resource path semantics or a drive-relative current directory.
    #[cfg(windows)]
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(root) = canonical_runtime_dir(parent.join("aki-watch-runtime")) {
                return root;
            }
        }
    }
    #[cfg(debug_assertions)]
    {
        // Development fallback only. Release builds must use packaged resources (or an explicit valid override)
        // so an installer can never silently depend on the build machine's source checkout.
        return Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from("."));
    }
    #[cfg(not(debug_assertions))]
    {
        PathBuf::from("__aki_watch_bundled_runtime_missing__")
    }
}

#[cfg(windows)]
fn hide_background_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_background_window(_command: &mut Command) {}

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

fn control_script() -> PathBuf {
    repo_dir().join("scripts").join("postman-pool-control.js")
}

fn telegram_script() -> PathBuf {
    repo_dir().join("scripts").join("postman-pool-telegram.py")
}

fn run_node_script(
    script: PathBuf,
    args: &[&str],
    stdin_data: Option<&str>,
) -> Result<String, String> {
    let repo = canonical_runtime_dir(repo_dir()).ok_or_else(|| {
        "Aki Watch runtime is missing or incomplete. Extract the portable ZIP first and keep aki-watch.exe beside aki-watch-runtime.".to_string()
    })?;
    let script = canonical_child_path(script.clone()).ok_or_else(|| {
        format!(
            "Aki Watch runtime script is unavailable: {}",
            script.display()
        )
    })?;
    if !script.is_file() {
        return Err(format!(
            "Aki Watch runtime script is not a file: {}",
            script.display()
        ));
    }
    let mut command = Command::new("node");
    command
        .arg(&script)
        .args(args)
        .current_dir(&repo)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_background_window(&mut command);
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
fn python_command() -> Command {
    #[cfg(windows)]
    {
        let mut command = Command::new("py");
        command.arg("-3");
        command
    }
    #[cfg(not(windows))]
    {
        Command::new("python3")
    }
}

fn run_py_capture(args: &[&str]) -> Result<String, String> {
    let repo = canonical_runtime_dir(repo_dir()).ok_or_else(|| {
        "Aki Watch runtime is missing or incomplete. Extract the portable ZIP first and keep aki-watch.exe beside aki-watch-runtime.".to_string()
    })?;
    let telegram = telegram_script();
    let script = canonical_child_path(telegram.clone()).ok_or_else(|| {
        format!(
            "Aki Watch Telegram runtime is unavailable: {}",
            telegram.display()
        )
    })?;
    let cfg = config_path();
    let mut command = python_command();
    command
        .arg("-X")
        .arg("utf8")
        .arg(&script)
        .args(args)
        .arg("--config")
        .arg(&cfg)
        .current_dir(&repo);
    hide_background_window(&mut command);
    let output = command
        .output()
        .map_err(|e| format!("failed to run Python ({}): {}", script.display(), e))?;
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
    let mut command = python_command();
    command
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

#[cfg(target_os = "macos")]
fn spawn_py_console(args: &[&str]) -> Result<String, String> {
    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }
    fn applescript_quote(value: &str) -> String {
        value.replace('\\', "\\\\").replace('"', "\\\"")
    }

    let repo = repo_dir();
    let script = telegram_script();
    let cfg = config_path();
    let mut parts = vec![
        "python3".to_string(),
        "-X".to_string(),
        "utf8".to_string(),
        script.to_string_lossy().into_owned(),
    ];
    parts.extend(args.iter().map(|value| (*value).to_string()));
    parts.push("--config".to_string());
    parts.push(cfg.to_string_lossy().into_owned());
    let command_line = format!(
        "cd {} && {}",
        shell_quote(&repo.to_string_lossy()),
        parts
            .iter()
            .map(|part| shell_quote(part))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let script_line = format!(
        "tell application \"Terminal\" to do script \"{}\"",
        applescript_quote(&command_line)
    );
    Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script_line)
        .spawn()
        .map_err(|e| format!("failed to open Terminal: {}", e))?;
    Ok("Opened Terminal. Complete the prompts there, then return here.".to_string())
}

#[cfg(target_os = "linux")]
fn spawn_py_console(args: &[&str]) -> Result<String, String> {
    let repo = repo_dir();
    let script = telegram_script();
    let cfg = config_path();
    let python_args = {
        let mut values = vec![
            "-X".to_string(),
            "utf8".to_string(),
            script.to_string_lossy().into_owned(),
        ];
        values.extend(args.iter().map(|value| (*value).to_string()));
        values.push("--config".to_string());
        values.push(cfg.to_string_lossy().into_owned());
        values
    };
    let terminals: [(&str, &[&str]); 3] = [
        ("x-terminal-emulator", &["-e"]),
        ("gnome-terminal", &["--"]),
        ("konsole", &["-e"]),
    ];
    for (terminal, prefix) in terminals {
        let mut command = Command::new(terminal);
        command
            .args(prefix)
            .arg("python3")
            .args(&python_args)
            .current_dir(&repo);
        if command.spawn().is_ok() {
            return Ok(format!(
                "Opened {}. Complete the prompts there, then return here.",
                terminal
            ));
        }
    }
    Err(
        "No supported terminal launcher found (x-terminal-emulator, gnome-terminal, or konsole)."
            .to_string(),
    )
}

async fn node_command(args: Vec<String>, stdin_data: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_node_script(setup_script(), &arg_refs, stdin_data.as_deref())
    })
    .await
    .map_err(|e| format!("spawn_blocking panicked: {}", e))?
}

async fn control_command(args: Vec<String>, stdin_data: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_node_script(control_script(), &arg_refs, stdin_data.as_deref())
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
async fn preflight() -> Result<String, String> {
    node_command(vec!["--preflight-json".into()], None).await
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

#[tauri::command]
async fn watcher_status() -> Result<String, String> {
    control_command(vec!["--watcher-status-json".into()], None).await
}

#[tauri::command]
async fn watcher_start() -> Result<String, String> {
    control_command(vec!["--watcher-start-json".into()], None).await
}

#[tauri::command]
async fn watcher_stop() -> Result<String, String> {
    control_command(vec!["--watcher-stop-json".into()], None).await
}

#[tauri::command]
async fn profiles_scan() -> Result<String, String> {
    control_command(vec!["--profiles-scan-json".into()], None).await
}

#[tauri::command]
async fn profiles_verify() -> Result<String, String> {
    control_command(vec!["--profiles-verify-json".into()], None).await
}

#[tauri::command]
async fn verify_start() -> Result<String, String> {
    control_command(vec!["--verify-start-json".into()], None).await
}

#[tauri::command]
async fn verify_status() -> Result<String, String> {
    control_command(vec!["--verify-status-json".into()], None).await
}

#[tauri::command]
async fn verify_stop() -> Result<String, String> {
    control_command(vec!["--verify-stop-json".into()], None).await
}

#[tauri::command]
async fn join_start(invite_url: String) -> Result<String, String> {
    let payload = serde_json::json!({ "inviteUrl": invite_url }).to_string();
    control_command(vec!["--join-start-json".into()], Some(payload)).await
}

#[tauri::command]
async fn join_status() -> Result<String, String> {
    control_command(vec!["--join-status-json".into()], None).await
}

#[tauri::command]
async fn join_stop() -> Result<String, String> {
    control_command(vec!["--join-stop-json".into()], None).await
}

#[cfg(windows)]
pub fn backend_smoke() -> Result<(), String> {
    run_node_script(control_script(), &["--join-status-json"], None).map(|_| ())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn child_process_paths_strip_windows_verbatim_prefixes() {
        assert_eq!(
            child_process_path(PathBuf::from(r"\\?\D:\Aki\script.js")),
            PathBuf::from(r"D:\Aki\script.js")
        );
        assert_eq!(
            child_process_path(PathBuf::from(r"\\?\UNC\server\share\script.js")),
            PathBuf::from(r"\\server\share\script.js")
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Ok(resource_dir) = app.path().resource_dir() {
                if let Some(runtime) = canonical_runtime_dir(resource_dir.join("aki-watch-runtime"))
                {
                    let _ = BUNDLED_RUNTIME_DIR.set(runtime);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            preflight,
            env_check,
            config_status,
            get_config,
            save_config,
            send_test,
            list_dialogs,
            launch_login,
            launch_observe,
            watcher_status,
            watcher_start,
            watcher_stop,
            profiles_scan,
            profiles_verify,
            verify_start,
            verify_status,
            verify_stop,
            join_start,
            join_status,
            join_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

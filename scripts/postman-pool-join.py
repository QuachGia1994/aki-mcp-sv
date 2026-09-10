#!/usr/bin/env python3
from __future__ import annotations

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qs, unquote, urlparse
from urllib.request import urlopen

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
CHROME_PROFILE_RE = re.compile(r"^(?:Default|Profile \d+)$", re.IGNORECASE)
POSTMAN_HOST_SUFFIXES = ("postman.com", "getpostman.com", "postman.co")
POSTMAN_APP_HOSTS = {"app.getpostman.com", "go.postman.co", "web.postman.co"}
JOINED_MARKERS = ("already a member", "already joined", "already part of", "you joined", "joined the team")
INVITE_FAILURE_MARKERS = ("invalid or expired invite code", "unable to join the team", "sign in", "log in", "sign up")
SECURITY_VERIFICATION_MARKERS = (
    "performing security verification",
    "verifies you are not a bot",
    "verify you are not a bot",
    "checking if the site connection is secure",
)


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def valid_invite_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not any(host == suffix or host.endswith(f".{suffix}") for suffix in POSTMAN_HOST_SUFFIXES):
        return False
    query = parse_qs(parsed.query)
    path = parsed.path.lower()
    return "invite_code" in query or "inviteCode" in query or "join-team" in path or "team-invite" in path or bool(re.search(r"(^|/)invite(?:/|$)", path))


def postman_app_destination(value: str) -> bool:
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    return parsed.scheme == "https" and parsed.hostname in POSTMAN_APP_HOSTS and not valid_invite_url(value)


def joined_signal(body: str) -> bool:
    lowered = body.lower()
    return any(marker in lowered for marker in JOINED_MARKERS)


def invite_failure_signal(body: str) -> bool:
    lowered = body.lower()
    return any(marker in lowered for marker in INVITE_FAILURE_MARKERS)


def security_verification_signal(url: str, body: str, title: str = "") -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    if not any(host == suffix or host.endswith(f".{suffix}") for suffix in POSTMAN_HOST_SUFFIXES):
        return False
    lowered = f"{title}\n{body}".lower()
    return any(marker in lowered for marker in SECURITY_VERIFICATION_MARKERS)


def emit_progress(event: dict) -> None:
    print(f"[postman-pool:event] {json.dumps(event, ensure_ascii=False)}", file=sys.stderr, flush=True)


def wait_for_security_verification(driver, By, timeout: int, progress: dict | None = None, poll_seconds: float = 1.0) -> bool:
    def snapshot() -> tuple[str, str]:
        try:
            body = driver.find_element(By.TAG_NAME, "body").text
        except Exception:
            body = ""
        try:
            title = driver.title or ""
        except Exception:
            title = ""
        return body, title

    body, title = snapshot()
    if not security_verification_signal(driver.current_url, body, title):
        return True
    emit_progress({"type": "manual_verification_required", **(progress or {})})
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(poll_seconds)
        body, title = snapshot()
        if not security_verification_signal(driver.current_url, body, title):
            emit_progress({"type": "manual_verification_resolved", **(progress or {})})
            return True
    return False


def chrome_identity_history_email(profile: Path, temp_dir: Path, index: int) -> str | None:
    source = profile / "History"
    if not source.exists():
        return None
    try:
        copy = temp_dir / f"chrome_identity_history_{index}.sqlite"
        shutil.copy2(source, copy)
        with closing(sqlite3.connect(copy)) as conn:
            rows = conn.execute("SELECT url FROM urls WHERE url LIKE '%identity.getpostman.com%' ORDER BY last_visit_time DESC").fetchall()
        for (url,) in rows:
            parsed = urlparse(unquote(url))
            if parsed.hostname != "identity.getpostman.com":
                continue
            for value in parse_qs(parsed.query).get("email", []):
                email = value.strip().lower()
                if EMAIL_RE.fullmatch(email):
                    return email
    except (OSError, sqlite3.Error):
        return None
    return None


def chrome_profile_directories(root: Path, requested: list[str] | None = None) -> list[str]:
    root = root.resolve()
    available: set[str] = set()
    local_state = root / "Local State"
    if local_state.exists():
        try:
            info_cache = json.loads(local_state.read_text(encoding="utf-8")).get("profile", {}).get("info_cache", {})
            for name in info_cache:
                if CHROME_PROFILE_RE.fullmatch(name) and (root / name).is_dir():
                    available.add(name)
        except (OSError, json.JSONDecodeError, AttributeError):
            pass
    try:
        for candidate in root.iterdir():
            if candidate.is_dir() and CHROME_PROFILE_RE.fullmatch(candidate.name):
                available.add(candidate.name)
    except OSError:
        pass

    def sort_key(name: str) -> tuple[int, int, str]:
        if name.casefold() == "default":
            return (0, 0, name.casefold())
        match = re.search(r"(\d+)$", name)
        return (1, int(match.group(1)) if match else 0, name.casefold())

    if requested:
        selected = []
        for name in requested:
            if name not in available:
                raise RuntimeError(f"Chrome profile directory not found: {name}")
            selected.append(name)
        return sorted(dict.fromkeys(selected), key=sort_key)
    return sorted(available, key=sort_key)


def is_default_chrome_user_data_root(root: Path) -> bool:
    candidates: list[Path] = []
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA")
        if local:
            base = Path(local) / "Google"
            candidates.extend([
                base / "Chrome" / "User Data",
                base / "Chrome Beta" / "User Data",
                base / "Chrome Dev" / "User Data",
                base / "Chrome SxS" / "User Data",
            ])
    normalized = os.path.normcase(os.path.abspath(str(root)))
    return any(normalized == os.path.normcase(os.path.abspath(str(candidate))) for candidate in candidates)


def discover_chrome_user_data_root(explicit: str | None) -> Path:
    if explicit:
        root = Path(explicit).expanduser()
    elif os.name == "nt" and Path("D:/").exists():
        root = Path(r"D:\LacViet\.aki-postman-cdp\chrome-user-data")
    else:
        root = Path.home() / ".aki" / "mcpsv" / "postman-chrome"
    root = root.resolve()
    if is_default_chrome_user_data_root(root):
        raise RuntimeError("Chrome/CDP requires a dedicated non-default user-data directory")
    root.mkdir(parents=True, exist_ok=True)
    return root


def discover_chrome_binary(explicit: str | None) -> Path:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    env_binary = os.environ.get("CHROME_BINARY")
    if env_binary:
        candidates.append(Path(env_binary))
    if os.name == "nt":
        for env_name in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            base = os.environ.get(env_name)
            if base:
                candidates.append(Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe")
    else:
        for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
            found = shutil.which(name)
            if found:
                candidates.append(Path(found))
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise RuntimeError("Chrome binary not found; set chromeBinary/--chrome-binary")


def choose_scratch_root(explicit: str | None) -> Path:
    if explicit:
        root = Path(explicit).expanduser()
    elif os.name == "nt" and Path("D:/").exists():
        root = Path(r"D:\LacViet\.aki-tmp\postman-pool")
    else:
        root = Path(tempfile.gettempdir()) / "aki-postman-pool"
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def selenium_modules():
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import WebDriverWait
    except ImportError as exc:
        raise RuntimeError("Selenium is not installed; run `py -3 -m pip install selenium`") from exc
    return webdriver, By, Options, EC, WebDriverWait


def free_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_cdp_endpoint(process: subprocess.Popen, port: int, timeout: int) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urlopen(f"http://127.0.0.1:{port}/json/version", timeout=0.5) as response:
                if json.load(response).get("webSocketDebuggerUrl"):
                    return
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        time.sleep(0.1)
    if process.poll() is not None:
        raise RuntimeError("Chrome launcher exited before its CDP endpoint became ready")
    raise RuntimeError("Chrome CDP endpoint did not start; close any Chrome window using this dedicated user-data directory and retry")


def launch_chrome_cdp(binary: Path, user_data_root: Path, profile_directory: str, timeout: int) -> tuple[subprocess.Popen, int]:
    port = free_local_port()
    command = [
        str(binary),
        f"--remote-debugging-port={port}",
        "--remote-debugging-address=127.0.0.1",
        f"--user-data-dir={user_data_root}",
        f"--profile-directory={profile_directory}",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
    ]
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for_cdp_endpoint(process, port, min(timeout, 20))
        return process, port
    except Exception:
        if process.poll() is None:
            process.terminate()
        raise


def chrome_cdp_driver(port: int, binary: Path):
    webdriver, _, Options, _, _ = selenium_modules()
    options = Options()
    options.binary_location = str(binary)
    options.debugger_address = f"127.0.0.1:{port}"
    return webdriver.Chrome(options=options)


def close_chrome_cdp(driver, process: subprocess.Popen | None) -> None:
    if driver:
        try:
            driver.execute_cdp_cmd("Browser.close", {})
        except Exception:
            pass
        try:
            driver.quit()
        except Exception:
            pass
    if not process or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def cdp_click_element(driver, element) -> None:
    rect = driver.execute_script("arguments[0].scrollIntoView({block:'center',inline:'center'}); const r=arguments[0].getBoundingClientRect(); return {x:r.left,y:r.top,width:r.width,height:r.height};", element)
    x = float(rect["x"]) + float(rect["width"]) / 2
    y = float(rect["y"]) + float(rect["height"]) / 2
    driver.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
    driver.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1})
    driver.execute_cdp_cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1})


def accept_invite(invite_url: str, user_data_root: Path, profile_directory: str, binary: Path, timeout: int, manual_verification_timeout: int, progress: dict | None = None) -> tuple[str, str | None]:
    _, By, _, EC, WebDriverWait = selenium_modules()
    process = None
    driver = None

    def body_text() -> str:
        try:
            return driver.find_element(By.TAG_NAME, "body").text
        except Exception:
            return ""

    def verification_cleared() -> bool:
        return wait_for_security_verification(driver, By, manual_verification_timeout, progress)

    try:
        process, port = launch_chrome_cdp(binary, user_data_root, profile_directory, timeout)
        driver = chrome_cdp_driver(port, binary)
        driver.execute_cdp_cmd("Page.navigate", {"url": invite_url})
        wait = WebDriverWait(driver, timeout)
        wait.until(lambda current: current.execute_script("return document.readyState") in ("interactive", "complete"))
        if not verification_cleared():
            return "manual_verification_timeout", "Cloudflare security verification was not completed in time"

        initial_url = driver.current_url
        lower_body = lambda: body_text().lower()
        button_xpaths = [
            "//button[translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')='accept invite']",
            "//a[translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')='accept invite']",
            "//button[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'join team')]",
            "//a[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'join team')]",
        ]
        clickable = None
        for xpath in button_xpaths:
            try:
                clickable = WebDriverWait(driver, 3).until(EC.element_to_be_clickable((By.XPATH, xpath)))
                break
            except Exception:
                if not verification_cleared():
                    return "manual_verification_timeout", "Cloudflare security verification was not completed in time"
                continue
        if clickable is None:
            body = lower_body()
            if joined_signal(body):
                return "already_joined", None
            if invite_failure_signal(body):
                if any(marker in body for marker in ("sign in", "log in", "sign up")):
                    return "failed", "Postman session is not signed in"
                return "failed", "Postman rejected or expired the invite"
            if postman_app_destination(driver.current_url):
                return "already_joined", None
            return "failed", "Accept Invite button not found"

        cdp_click_element(driver, clickable)
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.5)
            if not verification_cleared():
                return "manual_verification_timeout", "Cloudflare security verification was not completed in time"
            current_url = driver.current_url
            body = lower_body()
            if invite_failure_signal(body):
                if any(marker in body for marker in ("sign in", "log in", "sign up")):
                    return "failed", "Postman session is not signed in"
                return "failed", "Postman rejected or expired the invite"
            if joined_signal(body):
                return "joined", None
            if current_url != initial_url and postman_app_destination(current_url):
                return "joined", None
        return "failed", "invite click did not reach a confirmed Postman team page"
    finally:
        close_chrome_cdp(driver, process)


def smoke_browser(user_data_root: Path, binary: Path, profile_directories: list[str], scratch_root: Path, timeout: int) -> dict:
    profiles = discover_rows(user_data_root, profile_directories, scratch_root)
    if not profiles:
        raise RuntimeError("no Chrome profiles found")
    process = None
    driver = None
    try:
        process, port = launch_chrome_cdp(binary, user_data_root, profiles[0]["profile"], timeout)
        driver = chrome_cdp_driver(port, binary)
        driver.execute_cdp_cmd("Page.navigate", {"url": "about:blank"})
        return {"ok": driver.current_url == "about:blank", "profile": profiles[0]["profile"], "userDataRoot": str(user_data_root)}
    finally:
        close_chrome_cdp(driver, process)


def write_joined_emails(rows: list[dict]) -> Path:
    target = Path.home() / ".aki" / "mcpsv" / "postman-emails.txt"
    target.parent.mkdir(parents=True, exist_ok=True)
    emails = sorted({row["email"] for row in rows if row.get("email")})
    target.write_text("\n".join(emails) + ("\n" if emails else ""), encoding="utf-8")
    return target


def discover_rows(user_data_root: Path, profile_directories: list[str], scratch_root: Path) -> list[dict]:
    with tempfile.TemporaryDirectory(prefix="identity-chrome-", dir=scratch_root) as temp_name:
        temp_dir = Path(temp_name)
        rows = []
        for index, profile_directory in enumerate(chrome_profile_directories(user_data_root, profile_directories)):
            profile = user_data_root / profile_directory
            rows.append({"profile": profile_directory, "name": profile_directory, "path": str(profile), "email": chrome_identity_history_email(profile, temp_dir, index)})
    deduped = []
    seen_emails: set[str] = set()
    for row in rows:
        email = row.get("email")
        if email and email in seen_emails:
            continue
        if email:
            seen_emails.add(email)
        deduped.append(row)
    return deduped


def run(invite_url: str, user_data_root: Path, binary: Path, profile_directories: list[str], scratch_root: Path, timeout: int, manual_verification_timeout: int) -> dict:
    if not valid_invite_url(invite_url):
        raise RuntimeError("not a recognized Postman invite URL")
    joined: list[dict] = []
    skipped: list[dict] = []
    failed: list[dict] = []
    profiles = discover_rows(user_data_root, profile_directories, scratch_root)
    if not profiles:
        raise RuntimeError("no Chrome profiles found")

    for row in profiles:
        try:
            log(f"[postman-pool] {row['profile']} -> {row.get('email') or 'email unknown'}")
            status, error = accept_invite(
                invite_url,
                user_data_root,
                row["profile"],
                binary,
                timeout,
                manual_verification_timeout,
                {"profile": row["profile"], "email": row.get("email")},
            )
            result = {"profile": row["profile"], "email": row.get("email"), "status": status}
            if error:
                result["error"] = error
            if status in ("joined", "already_joined"):
                joined.append(result)
            elif status == "skipped":
                skipped.append(result)
            else:
                failed.append(result)
        except Exception as exc:
            failed.append({"profile": row["profile"], "email": row.get("email"), "status": "failed", "error": str(exc)})

    email_file = write_joined_emails(joined)
    return {"joined": joined, "skipped": skipped, "failed": failed, "emailFile": str(email_file)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Join a Postman invite with dedicated Chrome profiles through CDP")
    parser.add_argument("--json-stdin", action="store_true")
    parser.add_argument("--invite")
    parser.add_argument("--chrome-binary")
    parser.add_argument("--chrome-user-data-root")
    parser.add_argument("--chrome-profile-directory", action="append", default=[])
    parser.add_argument("--scratch-root")
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--manual-verification-timeout", type=int, default=300)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--smoke-browser", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    invite_url = args.invite
    if args.json_stdin:
        try:
            payload = json.loads(sys.stdin.readline())
            invite_url = payload.get("inviteUrl")
        except (json.JSONDecodeError, AttributeError):
            print(json.dumps({"error": "invalid JSON input"}))
            return 2
    try:
        scratch_root = choose_scratch_root(args.scratch_root)
        user_data_root = discover_chrome_user_data_root(args.chrome_user_data_root)
        binary = discover_chrome_binary(args.chrome_binary)
        profiles = discover_rows(user_data_root, args.chrome_profile_directory, scratch_root)
        if args.dry_run:
            print(json.dumps({"chromeBinary": str(binary), "chromeUserDataRoot": str(user_data_root), "scratchRoot": str(scratch_root), "profiles": profiles}, ensure_ascii=False))
            return 0
        if args.smoke_browser:
            print(json.dumps(smoke_browser(user_data_root, binary, args.chrome_profile_directory, scratch_root, max(10, min(120, args.timeout))), ensure_ascii=False))
            return 0
        if not invite_url:
            raise RuntimeError("invite URL is required")
        result = run(
            invite_url,
            user_data_root,
            binary,
            args.chrome_profile_directory,
            scratch_root,
            max(10, min(120, args.timeout)),
            max(60, min(900, args.manual_verification_timeout)),
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

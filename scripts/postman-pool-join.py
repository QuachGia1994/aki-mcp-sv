#!/usr/bin/env python3
from __future__ import annotations

import argparse
import configparser
from contextlib import closing
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile
import time
from urllib.parse import parse_qs, unquote, urlparse

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
NUMBERED_PROFILE_RE = re.compile(r"(?:profile|hồ sơ)\s*\d+$", re.IGNORECASE)
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
CACHE_DIRS = {
    "cache2",
    "startupCache",
    "shader-cache",
    "jumpListCache",
    "crashes",
    "minidumps",
    "thumbnails",
    "safebrowsing",
}
LOCK_FILES = {"parent.lock", "lock", ".parentlock"}


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


def gecko_profiles(root: Path) -> list[tuple[str, Path]]:
    parser = configparser.ConfigParser()
    profiles: list[tuple[str, Path]] = []
    seen: set[str] = set()

    def add_profile(name: str, profile_path: Path) -> None:
        if not profile_path.is_dir():
            return
        key = str(profile_path.resolve()).lower()
        if key in seen:
            return
        seen.add(key)
        profiles.append((name, profile_path))

    ini = root / "profiles.ini"
    if ini.exists():
        try:
            parser.read(ini, encoding="utf-8")
            for section in parser.sections():
                if not section.startswith("Profile") or not parser.has_option(section, "Path"):
                    continue
                name = parser.get(section, "Name", fallback="")
                raw = parser.get(section, "Path")
                profile_path = root / raw if parser.getboolean(section, "IsRelative", fallback=True) else Path(raw)
                add_profile(name, profile_path)
        except (OSError, configparser.Error):
            pass

    profiles_dir = root / "Profiles"
    if profiles_dir.is_dir():
        for profile_path in profiles_dir.iterdir():
            if profile_path.is_dir():
                add_profile(profile_path.name, profile_path)
    return profiles


def preferred_profiles(root: Path) -> list[tuple[str, Path]]:
    return sorted(gecko_profiles(root), key=lambda item: item[1].name.casefold())


def decode_email(value: object) -> str | None:
    candidates: list[str] = []
    if isinstance(value, str):
        candidates.append(value)
    elif isinstance(value, bytes):
        for encoding in ("utf-8", "utf-16-le"):
            try:
                candidates.append(value.decode(encoding))
            except UnicodeDecodeError:
                pass
    for candidate in candidates:
        candidate = candidate.strip().strip('"')
        if EMAIL_RE.fullmatch(candidate):
            return candidate.lower()
    return None


def local_storage_emails(profile: Path) -> set[str]:
    storage = profile / "storage" / "default"
    if not storage.is_dir():
        return set()
    emails: set[str] = set()
    for origin in storage.iterdir():
        if not origin.is_dir() or "postman" not in origin.name.lower():
            continue
        database = origin / "ls" / "data.sqlite"
        if not database.exists():
            continue
        try:
            uri = database.resolve().as_uri() + "?mode=ro"
            with closing(sqlite3.connect(uri, uri=True)) as conn:
                rows = conn.execute("SELECT value FROM data WHERE key LIKE '%.email' AND compression_type = 0").fetchall()
            for (value,) in rows:
                email = decode_email(value)
                if email:
                    emails.add(email)
        except (OSError, sqlite3.Error):
            continue
    return emails


def identity_history_email(profile: Path, temp_dir: Path, index: int) -> str | None:
    source = profile / "places.sqlite"
    if not source.exists():
        return None
    try:
        copy = temp_dir / f"identity_places_{index}.sqlite"
        shutil.copy2(source, copy)
        with closing(sqlite3.connect(copy)) as conn:
            rows = conn.execute(
                "SELECT p.url, MAX(v.visit_date) AS last_visit "
                "FROM moz_places p LEFT JOIN moz_historyvisits v ON v.place_id = p.id "
                "WHERE p.url LIKE '%identity.getpostman.com%' "
                "GROUP BY p.id ORDER BY last_visit DESC"
            ).fetchall()
        for url, _ in rows:
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


def profile_email(profile: Path, temp_dir: Path, index: int) -> str | None:
    identity = identity_history_email(profile, temp_dir, index)
    if identity:
        return identity
    stored = sorted(local_storage_emails(profile))
    return stored[0] if stored else None


def discover_profile_root(explicit: str | None) -> Path:
    candidates = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    if os.name == "nt":
        appdata = os.environ.get("APPDATA")
        if appdata:
            candidates.append(Path(appdata) / "LibreWolf")
    else:
        candidates.extend([Path.home() / ".librewolf", Path.home() / ".mozilla/firefox"])
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    raise RuntimeError("LibreWolf profile root not found")


def discover_binary(explicit: str | None) -> Path:
    candidates = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    env_binary = os.environ.get("LIBREWOLF_BINARY")
    if env_binary:
        candidates.append(Path(env_binary))
    if os.name == "nt":
        candidates.extend([Path(r"C:\Program Files\LibreWolf\librewolf.exe"), Path(r"C:\Program Files (x86)\LibreWolf\librewolf.exe")])
    else:
        found = shutil.which("librewolf")
        if found:
            candidates.append(Path(found))
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise RuntimeError("LibreWolf binary not found")


def choose_scratch_root(explicit: str | None) -> Path:
    if explicit:
        root = Path(explicit).expanduser()
    elif os.name == "nt" and Path("D:/").exists():
        root = Path(r"D:\LacViet\.aki-tmp\postman-pool")
    else:
        root = Path(tempfile.gettempdir()) / "aki-postman-pool"
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def cleanup_stale_runs(scratch_root: Path, max_age_seconds: int = 3600) -> None:
    now = time.time()
    for candidate in scratch_root.glob("run-*"):
        try:
            if candidate.is_dir() and now - candidate.stat().st_mtime >= max_age_seconds:
                shutil.rmtree(candidate, ignore_errors=True)
        except OSError:
            continue


def clone_profile(source: Path, scratch_root: Path) -> Path:
    target = Path(tempfile.mkdtemp(prefix="profile-", dir=scratch_root))

    def ignore(_dir: str, names: list[str]) -> set[str]:
        return {name for name in names if name in CACHE_DIRS or name in LOCK_FILES}

    shutil.copytree(source, target, dirs_exist_ok=True, ignore=ignore)
    return target


def selenium_modules():
    try:
        from selenium import webdriver
        from selenium.webdriver.common.by import By
        from selenium.webdriver.firefox.options import Options
        from selenium.webdriver.firefox.service import Service
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import WebDriverWait
    except ImportError as exc:
        raise RuntimeError("Selenium is not installed; run `py -3 -m pip install selenium`") from exc
    return webdriver, By, Options, Service, EC, WebDriverWait


def firefox_driver(profile_clone: Path, binary: Path, scratch_root: Path):
    webdriver, _, Options, Service, _, _ = selenium_modules()
    options = Options()
    options.binary_location = str(binary)
    options.add_argument("-no-remote")
    options.add_argument("-profile")
    options.add_argument(str(profile_clone))
    service = Service(service_args=["--profile-root", str(scratch_root)], log_output=os.devnull)
    return webdriver.Firefox(options=options, service=service)


def accept_invite(
    invite_url: str,
    profile_clone: Path,
    binary: Path,
    scratch_root: Path,
    timeout: int,
    manual_verification_timeout: int,
    progress: dict | None = None,
) -> tuple[str, str | None]:
    _, By, _, _, EC, WebDriverWait = selenium_modules()
    driver = firefox_driver(profile_clone, binary, scratch_root)

    def body_text() -> str:
        try:
            return driver.find_element(By.TAG_NAME, "body").text
        except Exception:
            return ""

    def verification_cleared() -> bool:
        return wait_for_security_verification(driver, By, manual_verification_timeout, progress)

    try:
        driver.get(invite_url)
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

        clickable.click()
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
        driver.quit()


def smoke_browser(profile_root: Path, binary: Path, scratch_root: Path) -> dict:
    profiles = discover_rows(profile_root, scratch_root)
    if not profiles:
        raise RuntimeError("no LibreWolf profiles found")
    cleanup_stale_runs(scratch_root)
    with tempfile.TemporaryDirectory(prefix="run-", dir=scratch_root) as run_name:
        run_root = Path(run_name)
        clone = clone_profile(Path(profiles[0]["path"]), run_root)
        driver = None
        try:
            driver = firefox_driver(clone, binary, run_root)
            driver.get("about:blank")
            return {"ok": driver.current_url == "about:blank", "profile": profiles[0]["profile"], "scratchRoot": str(scratch_root)}
        finally:
            if driver:
                driver.quit()
            shutil.rmtree(clone, ignore_errors=True)


def write_joined_emails(rows: list[dict]) -> Path:
    target = Path.home() / ".aki" / "mcpsv" / "postman-emails.txt"
    target.parent.mkdir(parents=True, exist_ok=True)
    emails = sorted({row["email"] for row in rows if row.get("email")})
    target.write_text("\n".join(emails) + ("\n" if emails else ""), encoding="utf-8")
    return target


def discover_rows(profile_root: Path, scratch_root: Path) -> list[dict]:
    with tempfile.TemporaryDirectory(prefix="identity-", dir=scratch_root) as temp_name:
        temp_dir = Path(temp_name)
        rows = []
        for index, (name, profile) in enumerate(preferred_profiles(profile_root)):
            rows.append({"profile": profile.name, "name": name, "path": str(profile), "email": profile_email(profile, temp_dir, index)})
    has_numbered = any(NUMBERED_PROFILE_RE.search(row["profile"]) for row in rows)
    if has_numbered:
        rows = [row for row in rows if NUMBERED_PROFILE_RE.search(row["profile"]) or row.get("email")]
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


def run(invite_url: str, profile_root: Path, binary: Path, scratch_root: Path, timeout: int, manual_verification_timeout: int) -> dict:
    if not valid_invite_url(invite_url):
        raise RuntimeError("not a recognized Postman invite URL")
    joined: list[dict] = []
    skipped: list[dict] = []
    failed: list[dict] = []
    profiles = discover_rows(profile_root, scratch_root)
    if not profiles:
        raise RuntimeError("no LibreWolf profiles found")
    cleanup_stale_runs(scratch_root)

    with tempfile.TemporaryDirectory(prefix="run-", dir=scratch_root) as run_name:
        run_root = Path(run_name)
        for row in profiles:
            source = Path(row["path"])
            clone = None
            try:
                log(f"[postman-pool] {row['profile']} -> {row.get('email') or 'email unknown'}")
                clone = clone_profile(source, run_root)
                status, error = accept_invite(
                    invite_url,
                    clone,
                    binary,
                    run_root,
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
            finally:
                if clone:
                    shutil.rmtree(clone, ignore_errors=True)

    email_file = write_joined_emails(joined)
    return {"joined": joined, "skipped": skipped, "failed": failed, "emailFile": str(email_file)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Join a Postman invite with existing LibreWolf profiles")
    parser.add_argument("--json-stdin", action="store_true")
    parser.add_argument("--invite")
    parser.add_argument("--profile-root")
    parser.add_argument("--librewolf-binary")
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
        profile_root = discover_profile_root(args.profile_root)
        binary = discover_binary(args.librewolf_binary)
        scratch_root = choose_scratch_root(args.scratch_root)
        if args.dry_run:
            print(json.dumps({"profileRoot": str(profile_root), "librewolfBinary": str(binary), "scratchRoot": str(scratch_root), "profiles": discover_rows(profile_root, scratch_root)}, ensure_ascii=False))
            return 0
        if args.smoke_browser:
            print(json.dumps(smoke_browser(profile_root, binary, scratch_root), ensure_ascii=False))
            return 0
        if not invite_url:
            raise RuntimeError("invite URL is required")
        result = run(
            invite_url,
            profile_root,
            binary,
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

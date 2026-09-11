#!/usr/bin/env python3
from __future__ import annotations

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qs, quote, unquote, urlparse

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
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
ACCOUNT_CARD_SELECTOR = "#account_select_container a.pm-card-account, a.pm-card-account, a[data-testid*='account-chooser']"
ACCOUNT_DISCOVERY_ATTEMPTS = 25
ACCOUNT_CARD_LOOKUP_ATTEMPTS = 15
ACCOUNT_JOIN_ATTEMPTS = 18
ACCOUNT_POLL_SECONDS = 2.0
ACCOUNT_SYNC_SECONDS = 4.0
# Files that mark a directory as a real LibreWolf/Firefox profile.
PROFILE_MARKER_FILES = ("prefs.js", "times.json", "compatibility.ini")
# When a Google/Postman "Keep these accounts separate" prompt appears, choose "Keep separate".
KEEP_SEPARATE_XPATHS = (
    "//button[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'keep separate')]",
    "//a[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'keep separate')]",
    "//*[@role='button'][contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'keep separate')]",
)
# A 400 / rate-limit page should be given a short pause and a refresh, a few times.
RATE_LIMIT_MARKERS = ("rate limit", "too many requests", "too many attempts")
RATE_LIMIT_WAIT_SECONDS = 2.0
MAX_RATE_LIMIT_REFRESHES = 6


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
    if parsed.scheme != "https":
        return False
    host = (parsed.hostname or "").lower()
    # The signed-in app lives on go/web.postman.co and on per-team subdomains like
    # <team>.postman.co (e.g. forever30d.postman.co), which is where an accepted invite lands.
    is_app = host in POSTMAN_APP_HOSTS or host == "postman.co" or host.endswith(".postman.co")
    return is_app and not valid_invite_url(value)


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


def invite_code_from_url(invite_url: str) -> str | None:
    try:
        query = parse_qs(urlparse(invite_url).query)
    except ValueError:
        return None
    for key in ("invite_code", "inviteCode"):
        for value in query.get(key, []):
            code = str(value).strip()
            if re.fullmatch(r"[A-Za-z0-9_-]{8,256}", code):
                return code
    return None


def account_chooser_url(invite_url: str) -> str:
    invite_code = invite_code_from_url(invite_url)
    if not invite_code:
        raise RuntimeError("Postman invite must contain invite_code for automatic account-chooser flow")
    continue_url = f"https://app.getpostman.com/web-invite-accept?invite_code={invite_code}"
    return (
        "https://identity.getpostman.com/accounts?cta=join-team"
        f"&invite_code={quote(invite_code, safe='')}"
        f"&continue={quote(continue_url, safe='')}"
    )


def team_destination_signal(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "https":
        return False
    host = (parsed.hostname or "").lower()
    if not (host == "postman.co" or host.endswith(".postman.co")):
        return False
    if host not in {"postman.co", "go.postman.co", "web.postman.co"}:
        return True
    path = parsed.path.lower().rstrip("/")
    return any(path == prefix or path.startswith(f"{prefix}/") for prefix in ("/home", "/workspace", "/onboarding"))


def transition_signal(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    path = parsed.path.lower()
    return host == "identity.getpostman.com" or (host == "app.getpostman.com" and "/web-invite-accept" in path)


def profile_display_name(dir_name: str) -> str:
    # LibreWolf profile folders are "<8char-id>.<Name>"; surface the human name when present.
    parts = dir_name.split(".", 1)
    return parts[1] if len(parts) == 2 and parts[1] else dir_name


def places_email(profile: Path, temp_dir: Path, index: int) -> str | None:
    source = profile / "places.sqlite"
    if not source.exists():
        return None
    try:
        copy = temp_dir / f"places_{index}.sqlite"
        shutil.copy2(source, copy)
        with closing(sqlite3.connect(copy)) as conn:
            rows = conn.execute(
                "SELECT url FROM moz_places WHERE url LIKE '%identity.getpostman.com%' ORDER BY last_visit_date DESC"
            ).fetchall()
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


def firefox_profile_directories(root: Path, requested: list[str] | None = None) -> list[str]:
    root = root.resolve()
    available: list[str] = []
    try:
        for candidate in root.iterdir():
            if candidate.is_dir() and any((candidate / marker).exists() for marker in PROFILE_MARKER_FILES):
                available.append(candidate.name)
    except OSError:
        pass

    def sort_key(name: str) -> tuple[int, int, str]:
        display = profile_display_name(name)
        match = re.search(r"(\d+)\s*$", display)
        return (0 if match else 1, int(match.group(1)) if match else 0, display.casefold())

    available.sort(key=sort_key)

    if requested:
        by_dir = {name.casefold(): name for name in available}
        by_display: dict[str, str] = {}
        for name in available:
            by_display.setdefault(profile_display_name(name).casefold(), name)
        selected: list[str] = []
        for want in requested:
            key = str(want).casefold()
            if key in by_dir:
                selected.append(by_dir[key])
            elif key in by_display:
                selected.append(by_display[key])
            else:
                raise RuntimeError(f"LibreWolf profile not found: {want}")
        return list(dict.fromkeys(selected))
    return available


def default_profiles_root() -> Path:
    if os.name == "nt":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return Path(appdata) / "librewolf" / "Profiles"
    home = Path.home()
    for candidate in (
        home / ".librewolf",
        home / ".mozilla" / "librewolf",
        home / "Library" / "Application Support" / "librewolf" / "Profiles",
    ):
        if candidate.exists():
            return candidate
    return home / ".librewolf"


def discover_profiles_root(explicit: str | None) -> Path:
    root = Path(explicit).expanduser() if explicit else default_profiles_root()
    root = root.resolve()
    if not root.exists():
        raise RuntimeError(f"LibreWolf profiles root not found: {root}")
    return root


def discover_librewolf_binary(explicit: str | None) -> Path:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    env_binary = os.environ.get("LIBREWOLF_BINARY")
    if env_binary:
        candidates.append(Path(env_binary))
    if os.name == "nt":
        for env_name in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
            base = os.environ.get(env_name)
            if base:
                candidates.append(Path(base) / "LibreWolf" / "librewolf.exe")
    else:
        for name in ("librewolf", "librewolf-bin"):
            found = shutil.which(name)
            if found:
                candidates.append(Path(found))
        candidates.extend([Path("/usr/bin/librewolf"), Path("/usr/local/bin/librewolf"), Path("/Applications/LibreWolf.app/Contents/MacOS/librewolf")])
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise RuntimeError("LibreWolf binary not found; set librewolfBinary/--librewolf-binary")


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
        from selenium.webdriver.common.by import By
        from selenium.webdriver.firefox.options import Options
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.support.ui import WebDriverWait
    except ImportError as exc:
        raise RuntimeError("Selenium is not installed; run `py -3 -m pip install selenium`") from exc
    return webdriver, By, Options, EC, WebDriverWait


# Only the files a signed-in session needs are copied, so the per-profile clone stays small:
# cookies, the NSS key/cert DBs, saved logins, prefs, permissions - plus Postman-origin web
# storage (localStorage/IndexedDB). Everything else (cache, history, places) is left behind.
PROFILE_COPY_FILES = (
    "cookies.sqlite",
    "cookies.sqlite-wal",
    "cookies.sqlite-shm",
    "key4.db",
    "cert9.db",
    "logins.json",
    "prefs.js",
    "user.js",
    "permissions.sqlite",
    "compatibility.ini",
    "times.json",
)
# Firefox encodes web-storage origins like "https+++go.postman.co"; match Postman origins only.
PROFILE_COPY_ORIGIN_KEYWORDS = ("postman",)


def copy_profile_for_automation(profile_dir: Path, scratch_root: Path) -> Path:
    # Clone only the signed-in-session files so geckodriver can drive a lightweight copy of the
    # profile even while the original LibreWolf window is open (the original stays untouched).
    profile_dir = Path(profile_dir)
    dest_parent = Path(tempfile.mkdtemp(prefix="lw-prof-", dir=scratch_root))
    target = dest_parent / "profile"
    target.mkdir(parents=True, exist_ok=True)

    def copy_one(src: Path, dst: Path) -> None:
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        except OSError:
            pass

    for name in PROFILE_COPY_FILES:
        src = profile_dir / name
        if src.is_file():
            copy_one(src, target / name)

    # Per-origin localStorage/IndexedDB, restricted to Postman origins to stay small.
    for bucket in ("default", "permanent", "temporary"):
        bucket_dir = profile_dir / "storage" / bucket
        if not bucket_dir.is_dir():
            continue
        try:
            origins = list(bucket_dir.iterdir())
        except OSError:
            continue
        for origin_dir in origins:
            if not origin_dir.is_dir():
                continue
            if not any(kw in origin_dir.name.lower() for kw in PROFILE_COPY_ORIGIN_KEYWORDS):
                continue
            for root, _dirs, files in os.walk(origin_dir):
                rel = Path(root).relative_to(profile_dir)
                for name in files:
                    if name.lower().endswith(".lock"):
                        continue
                    copy_one(Path(root) / name, target / rel / name)

    # Small top-level files directly under storage/ (e.g. ls-archive.sqlite).
    storage_root = profile_dir / "storage"
    if storage_root.is_dir():
        try:
            for entry in storage_root.iterdir():
                if entry.is_file():
                    copy_one(entry, target / "storage" / entry.name)
        except OSError:
            pass

    return target


def firefox_driver(binary: Path, profile_dir: Path, headless: bool, page_load_timeout: int, scratch_root: Path):
    webdriver, _, Options, _, _ = selenium_modules()
    options = Options()
    options.binary_location = str(binary)
    if headless:
        options.add_argument("-headless")
    # Drive a copy of the caller's LibreWolf profile so its signed-in Postman session is reused
    # without locking or modifying the original (which may already be open).
    profile_copy = copy_profile_for_automation(Path(profile_dir), scratch_root)
    options.add_argument("-profile")
    options.add_argument(str(profile_copy))
    driver = webdriver.Firefox(options=options)
    setattr(driver, "_aki_profile_copy_root", str(profile_copy.parent))
    try:
        driver.set_page_load_timeout(page_load_timeout)
    except Exception:
        pass
    return driver


def close_firefox(driver) -> None:
    if not driver:
        return
    copy_root = getattr(driver, "_aki_profile_copy_root", None)
    try:
        driver.quit()
    except Exception:
        pass
    if copy_root:
        shutil.rmtree(copy_root, ignore_errors=True)


def click_element(driver, element) -> None:
    try:
        driver.execute_script("arguments[0].scrollIntoView({block:'center',inline:'center'});", element)
    except Exception:
        pass
    try:
        element.click()
    except Exception:
        driver.execute_script("arguments[0].click();", element)


def rate_limit_signal(body: str, title: str = "") -> bool:
    lowered = f"{title}\n{body}".lower()
    if any(marker in lowered for marker in RATE_LIMIT_MARKERS):
        return True
    # A bare HTTP 400 page that also mentions "rate" is the reported failure mode.
    return "400" in lowered and "rate" in lowered


def dismiss_keep_separate(driver, By) -> bool:
    # Google/Postman sign-in can show "Keep these accounts separate"; always keep separate.
    for xpath in KEEP_SEPARATE_XPATHS:
        try:
            elements = driver.find_elements(By.XPATH, xpath)
        except Exception:
            elements = []
        for element in elements:
            try:
                if element.is_displayed():
                    click_element(driver, element)
                    return True
            except Exception:
                continue
    return False


def postman_auth_state(driver, By) -> str:
    # Classify a loaded Postman page as authenticated / not_signed_in / cloudflare_challenge.
    try:
        url = driver.current_url
    except Exception:
        url = ""
    try:
        body = driver.find_element(By.TAG_NAME, "body").text
    except Exception:
        body = ""
    try:
        title = driver.title or ""
    except Exception:
        title = ""
    if security_verification_signal(url, body, title):
        return "cloudflare_challenge"
    lowered = body.lower()
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        host = ""
    if host == "identity.getpostman.com":
        return "not_signed_in"
    # An unauthenticated go.postman.co redirects to identity.getpostman.com; staying on any
    # *.postman.co host (app or a per-team subdomain) means the copied session is signed in.
    if host == "postman.co" or host.endswith(".postman.co"):
        if any(marker in lowered for marker in ("sign in to postman", "log in to postman")):
            return "not_signed_in"
        return "authenticated"
    if any(marker in lowered for marker in ("sign in", "log in")):
        return "not_signed_in"
    return "unknown"


def profile_session_inventory(profile_dir: Path) -> dict:
    # Report which allowlisted session files and Postman web-storage origins the profile has.
    profile_dir = Path(profile_dir)
    files = [name for name in PROFILE_COPY_FILES if (profile_dir / name).is_file()]
    origins: list[str] = []
    for bucket in ("default", "permanent", "temporary"):
        bucket_dir = profile_dir / "storage" / bucket
        if not bucket_dir.is_dir():
            continue
        try:
            for origin_dir in bucket_dir.iterdir():
                if origin_dir.is_dir() and any(kw in origin_dir.name.lower() for kw in PROFILE_COPY_ORIGIN_KEYWORDS):
                    origins.append(f"{bucket}/{origin_dir.name}")
        except OSError:
            continue
    return {"files": files, "postmanOrigins": origins}


def wait_document_ready(driver, timeout: int) -> None:
    try:
        _, _, _, _, WebDriverWait = selenium_modules()
        WebDriverWait(driver, timeout).until(lambda current: current.execute_script("return document.readyState") in ("interactive", "complete"))
    except Exception:
        pass


def discover_account_cards(driver, attempts: int = ACCOUNT_DISCOVERY_ATTEMPTS, poll_seconds: float = ACCOUNT_POLL_SECONDS) -> dict | None:
    script = f"""
const cards = Array.from(document.querySelectorAll({json.dumps(ACCOUNT_CARD_SELECTOR)}));
const list = [];
for (const c of cards) {{
  const emailEl = c.querySelector('.email') || c.querySelector('[title*="@"]');
  let email = emailEl ? (emailEl.innerText || emailEl.title || '').trim() : '';
  if (!email) {{
    const match = (c.innerText || '').match(/[\\w.\\-+]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{{2,}}/);
    if (match) email = match[0];
  }}
  const nameEl = c.querySelector('.name') || c.querySelector('h3');
  const name = nameEl ? (nameEl.innerText || '').trim() : '';
  if (email && !list.some(x => x.email.toLowerCase() === email.toLowerCase())) {{
    list.push({{ email, name, href: c.href }});
  }}
}}
const teamTitleEl = document.querySelector('h1, h2, .team-name, [data-testid*="team"]');
return {{ count: list.length, accounts: list, teamName: teamTitleEl ? teamTitleEl.innerText.trim() : '', url: window.location.href }};
"""
    for retry in range(attempts):
        if retry:
            time.sleep(poll_seconds)
        try:
            result = driver.execute_script(script)
        except Exception:
            result = None
        if isinstance(result, dict) and result.get("accounts"):
            return result
        emit_progress({"type": "account_discovery_wait", "attempt": retry + 1, "totalAttempts": attempts})
    return None


def find_account_card_href(driver, email: str, attempts: int = ACCOUNT_CARD_LOOKUP_ATTEMPTS, poll_seconds: float = ACCOUNT_POLL_SECONDS) -> str | None:
    script = f"""
const targetEmail = String(arguments[0] || '').toLowerCase();
const cards = Array.from(document.querySelectorAll({json.dumps(ACCOUNT_CARD_SELECTOR)}));
for (const c of cards) {{
  if ((c.innerText || '').toLowerCase().includes(targetEmail)) return c.href || null;
}}
return null;
"""
    for attempt in range(attempts):
        if attempt:
            time.sleep(poll_seconds)
        try:
            href = driver.execute_script(script, email)
        except Exception:
            href = None
        if isinstance(href, str) and href.startswith("https://"):
            return href
    return None


def automatic_accept_step(driver) -> dict:
    script = r"""
const url = window.location.href;
const buttons = Array.from(document.querySelectorAll("button, a, input[type='button'], input[type='submit']"));
let clicked = null;
for (const b of buttons) {
  const text = (b.innerText || b.value || '').trim();
  if (/sign in with a different account/i.test(text)) continue;
  if (/join team|accept invite|tham gia|confirm|continue|switch team|đồng ý|chấp nhận/i.test(text)) {
    b.click();
    clicked = text;
    break;
  }
}
let checked = 0;
for (const cb of Array.from(document.querySelectorAll("input[type='checkbox']"))) {
  if (!cb.checked) {
    cb.click();
    checked += 1;
  }
}
return { url, clicked, checked };
"""
    try:
        result = driver.execute_script(script)
        return result if isinstance(result, dict) else {"url": driver.current_url, "clicked": None, "checked": 0}
    except Exception:
        try:
            return {"url": driver.current_url, "clicked": None, "checked": 0}
        except Exception:
            return {"url": "", "clicked": None, "checked": 0}


def process_chooser_account(driver, chooser_url: str, account: dict, timeout: int, progress: dict) -> tuple[str, str | None, str | None]:
    _, By, _, _, _ = selenium_modules()
    email = str(account.get("email") or "").strip()
    if not email:
        return "failed", "Postman account card has no email", None

    try:
        driver.get(chooser_url)
    except Exception:
        pass
    wait_document_ready(driver, timeout)
    card_href = find_account_card_href(driver, email)
    if not card_href:
        return "failed", "Postman account card was not found after returning to the account chooser", None

    emit_progress({"type": "account_status", "status": "switching_session", "email": email, **progress})
    try:
        driver.get(card_href)
    except Exception:
        pass

    final_url = None
    challenge_seen = False
    join_confirmation_seen = False
    rate_limit_refreshes = 0
    for attempt in range(ACCOUNT_JOIN_ATTEMPTS):
        time.sleep(ACCOUNT_POLL_SECONDS)
        dismiss_keep_separate(driver, By)
        step = automatic_accept_step(driver)
        try:
            final_url = driver.current_url
        except Exception:
            final_url = step.get("url") or final_url
        body = ""
        title = ""
        try:
            body = driver.find_element(By.TAG_NAME, "body").text
        except Exception:
            pass
        try:
            title = driver.title or ""
        except Exception:
            pass

        if security_verification_signal(final_url or "", body, title):
            challenge_seen = True
        if rate_limit_signal(body, title) and rate_limit_refreshes < MAX_RATE_LIMIT_REFRESHES:
            rate_limit_refreshes += 1
            emit_progress({"type": "rate_limited", "refresh": rate_limit_refreshes, "email": email, **progress})
            time.sleep(RATE_LIMIT_WAIT_SECONDS)
            try:
                driver.refresh()
            except Exception:
                pass
            continue
        if step.get("clicked"):
            emit_progress({"type": "account_status", "status": "auto_clicked", "clicked": step.get("clicked"), "email": email, **progress})
        elif transition_signal(final_url or ""):
            emit_progress({"type": "account_status", "status": "waiting_transition", "attempt": attempt + 1, "totalAttempts": ACCOUNT_JOIN_ATTEMPTS, "email": email, **progress})

        if team_destination_signal(final_url or ""):
            emit_progress({"type": "account_status", "status": "joined_syncing", "email": email, **progress})
            time.sleep(ACCOUNT_SYNC_SECONDS)
            return "joined", None, final_url
        if joined_signal(body):
            join_confirmation_seen = True
        if invite_failure_signal(body) and not transition_signal(final_url or ""):
            if any(marker in body.lower() for marker in ("sign in", "log in", "sign up")):
                return "failed", "Postman account session is not signed in", final_url
            return "failed", "Postman rejected or expired the invite", final_url

    if challenge_seen:
        return "failed", "Postman security challenge did not clear automatically before the join timeout", final_url
    if join_confirmation_seen:
        return "failed", "Postman showed join confirmation but did not complete the team transition", final_url
    return "failed", "Postman did not reach a confirmed team page after automatic account switch/accept", final_url


def discover_rows(profiles_root: Path, profile_directories: list[str], scratch_root: Path) -> list[dict]:
    with tempfile.TemporaryDirectory(prefix="places-", dir=scratch_root) as temp_name:
        temp_dir = Path(temp_name)
        rows = []
        for index, dir_name in enumerate(firefox_profile_directories(profiles_root, profile_directories)):
            profile = profiles_root / dir_name
            rows.append({
                "profile": profile_display_name(dir_name),
                "dir": dir_name,
                "path": str(profile),
                "email": places_email(profile, temp_dir, index),
            })
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


def smoke_browser(profiles_root: Path, binary: Path, profile_directories: list[str], scratch_root: Path, headless: bool, timeout: int) -> dict:
    profiles = discover_rows(profiles_root, profile_directories, scratch_root)
    if not profiles:
        raise RuntimeError("no LibreWolf profiles found")
    driver = None
    try:
        driver = firefox_driver(binary, Path(profiles[0]["path"]), headless, timeout, scratch_root)
        driver.get("about:blank")
        caps = driver.capabilities or {}
        return {
            "ok": driver.current_url in ("about:blank", "about:blank#blocked"),
            "profile": profiles[0]["profile"],
            "profileDir": profiles[0]["dir"],
            "profilesRoot": str(profiles_root),
            "browserVersion": caps.get("browserVersion"),
            "geckodriverVersion": caps.get("moz:geckodriverVersion"),
        }
    finally:
        close_firefox(driver)


def verify_login(profiles_root: Path, binary: Path, profile_directories: list[str], scratch_root: Path, headless: bool, timeout: int, verify_url: str) -> dict:
    _, By, _, _, WebDriverWait = selenium_modules()
    profiles = discover_rows(profiles_root, profile_directories, scratch_root)
    if not profiles:
        raise RuntimeError("no LibreWolf profiles found")
    results = []
    for index, row in enumerate(profiles, 1):
        emit_progress({"type": "verify_start", "index": index, "total": len(profiles), "profile": row["profile"], "email": row.get("email")})
        inventory = profile_session_inventory(Path(row["path"]))
        entry = {
            "profile": row["profile"],
            "email": row.get("email"),
            "sessionFiles": inventory["files"],
            "postmanOrigins": inventory["postmanOrigins"],
        }
        driver = None
        try:
            log(f"[postman-pool] verify {row['profile']} -> {row.get('email') or 'email unknown'}")
            driver = firefox_driver(binary, Path(row["path"]), headless, timeout, scratch_root)
            try:
                driver.get(verify_url)
            except Exception:
                pass
            try:
                WebDriverWait(driver, timeout).until(lambda d: d.execute_script("return document.readyState") in ("interactive", "complete"))
            except Exception:
                pass
            time.sleep(2)
            dismiss_keep_separate(driver, By)
            entry["authState"] = postman_auth_state(driver, By)
            try:
                entry["finalUrl"] = driver.current_url
            except Exception:
                entry["finalUrl"] = None
        except Exception as exc:
            entry["authState"] = "error"
            entry["error"] = str(exc)
        finally:
            close_firefox(driver)
        results.append(entry)
        emit_progress({"type": "verify_done", "index": index, "total": len(profiles), **entry})
    return {"verifyUrl": verify_url, "results": results}


def write_joined_emails(rows: list[dict]) -> Path:
    target = Path.home() / ".aki" / "mcpsv" / "postman-emails.txt"
    target.parent.mkdir(parents=True, exist_ok=True)
    emails = sorted({row["email"] for row in rows if row.get("email")})
    target.write_text("\n".join(emails) + ("\n" if emails else ""), encoding="utf-8")
    return target


def run(invite_url: str, profiles_root: Path, binary: Path, profile_directories: list[str], scratch_root: Path, headless: bool, timeout: int) -> dict:
    if not valid_invite_url(invite_url):
        raise RuntimeError("not a recognized Postman invite URL")
    chooser_url = account_chooser_url(invite_url)
    joined: list[dict] = []
    skipped: list[dict] = []
    failed: list[dict] = []
    profiles = discover_rows(profiles_root, profile_directories, scratch_root)
    if not profiles:
        raise RuntimeError("no LibreWolf profiles found")

    seen_emails: set[str] = set()
    processed = 0
    discovered_total = 0
    baseline_total = len(profiles)

    for row in profiles:
        profile_name = row["profile"]
        driver = None
        try:
            log(f"[postman-pool] chooser scan {profile_name} -> {row.get('email') or 'email unknown'}")
            driver = firefox_driver(binary, Path(row["path"]), headless, timeout, scratch_root)
            try:
                driver.get(chooser_url)
            except Exception:
                pass
            wait_document_ready(driver, timeout)
            discovery = discover_account_cards(driver)
            accounts = list(discovery.get("accounts") or []) if discovery else []
            unique_accounts = []
            for account in accounts:
                email = str(account.get("email") or "").strip().lower()
                if not email or email in seen_emails:
                    continue
                seen_emails.add(email)
                unique_accounts.append({**account, "email": email})

            if accounts and not unique_accounts:
                emit_progress({"type": "profile_skipped", "profile": profile_name, "reason": "duplicate_accounts"})
                continue
            if not unique_accounts:
                processed += 1
                total = max(baseline_total, discovered_total, processed)
                result = {
                    "profile": profile_name,
                    "email": row.get("email"),
                    "status": "failed",
                    "error": "No signed-in Postman account cards were found in the account chooser for this LibreWolf profile",
                }
                emit_progress({"type": "account_start", "index": processed, "total": total, "profile": profile_name, "email": row.get("email")})
                emit_progress({"type": "account_done", "index": processed, "total": total, **result})
                failed.append(result)
                continue

            discovered_total += len(unique_accounts)
            total = max(baseline_total, discovered_total)
            emit_progress({
                "type": "accounts_discovered",
                "profile": profile_name,
                "teamName": (discovery or {}).get("teamName") or "",
                "count": len(unique_accounts),
                "total": total,
                "accounts": [{"email": account.get("email"), "name": account.get("name") or ""} for account in unique_accounts],
            })

            for account in unique_accounts:
                processed += 1
                total = max(baseline_total, discovered_total, processed)
                email = account.get("email")
                base = {"profile": profile_name, "email": email, "name": account.get("name") or ""}
                emit_progress({"type": "account_start", "index": processed, "total": total, **base})
                status, error, _ = process_chooser_account(
                    driver,
                    chooser_url,
                    account,
                    timeout,
                    {"profile": profile_name},
                )
                result = {**base, "status": status}
                if error:
                    result["error"] = error
                if status in ("joined", "already_joined"):
                    joined.append(result)
                elif status == "skipped":
                    skipped.append(result)
                else:
                    failed.append(result)
                emit_progress({"type": "account_done", "index": processed, "total": total, **result})
        except Exception as exc:
            processed += 1
            total = max(baseline_total, discovered_total, processed)
            result = {"profile": profile_name, "email": row.get("email"), "status": "failed", "error": str(exc)}
            failed.append(result)
            emit_progress({"type": "account_done", "index": processed, "total": total, **result})
        finally:
            close_firefox(driver)

    email_file = write_joined_emails(joined)
    return {"joined": joined, "skipped": skipped, "failed": failed, "emailFile": str(email_file)}


def write_result_file(result_file: str | None, payload: str) -> None:
    if not result_file:
        return
    target = Path(result_file)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(target)


def detached_child_argv(argv: list[str]) -> list[str]:
    # Re-run this same worker without --detach so the parent can exit immediately.
    child = [arg for arg in argv[1:] if arg != "--detach"]
    return [sys.executable, os.path.abspath(__file__), *child]


def spawn_detached(argv: list[str], log_file: str | None) -> int:
    stdout = subprocess.DEVNULL
    if log_file:
        Path(log_file).parent.mkdir(parents=True, exist_ok=True)
        stdout = open(log_file, "w", encoding="utf-8")  # noqa: SIM115 - handed to the child
    kwargs = {"stdin": subprocess.DEVNULL, "stdout": stdout, "stderr": subprocess.STDOUT, "close_fds": True}
    if os.name == "nt":
        kwargs["creationflags"] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    child = subprocess.Popen(argv, **kwargs)
    return child.pid


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Join a Postman invite with dedicated LibreWolf profiles through geckodriver")
    parser.add_argument("--json-stdin", action="store_true")
    parser.add_argument("--invite")
    parser.add_argument("--librewolf-binary")
    parser.add_argument("--profiles-root")
    parser.add_argument("--profile-directory", action="append", default=[])
    parser.add_argument("--scratch-root")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--smoke-browser", action="store_true")
    parser.add_argument("--verify-login", action="store_true", help="open each profile copy and report whether its Postman session is still authenticated")
    parser.add_argument("--verify-url", default="https://go.postman.co/", help="page to load for the login check")
    parser.add_argument("--detach", action="store_true", help="run the join in a background process and return immediately")
    parser.add_argument("--result-file", help="write the final JSON result to this path")
    parser.add_argument("--log-file", help="when detached, redirect the background run's stdout/stderr here")
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
        profiles_root = discover_profiles_root(args.profiles_root)
        binary = discover_librewolf_binary(args.librewolf_binary)
        if args.dry_run:
            profiles = discover_rows(profiles_root, args.profile_directory, scratch_root)
            print(json.dumps({"librewolfBinary": str(binary), "profilesRoot": str(profiles_root), "scratchRoot": str(scratch_root), "profiles": profiles}, ensure_ascii=False))
            return 0
        if args.smoke_browser:
            print(json.dumps(smoke_browser(profiles_root, binary, args.profile_directory, scratch_root, args.headless, max(10, min(120, args.timeout))), ensure_ascii=False))
            return 0
        if args.verify_login:
            payload = json.dumps(verify_login(profiles_root, binary, args.profile_directory, scratch_root, args.headless, max(10, min(120, args.timeout)), args.verify_url), ensure_ascii=False)
            write_result_file(args.result_file, payload)
            print(payload)
            return 0
        if not invite_url:
            raise RuntimeError("invite URL is required")
        if args.detach:
            if not args.result_file:
                raise RuntimeError("--detach requires --result-file")
            pid = spawn_detached(detached_child_argv(sys.argv), args.log_file)
            print(json.dumps({"detached": True, "pid": pid, "resultFile": os.path.abspath(args.result_file), "logFile": os.path.abspath(args.log_file) if args.log_file else None}, ensure_ascii=False))
            return 0
        result = run(
            invite_url,
            profiles_root,
            binary,
            args.profile_directory,
            scratch_root,
            args.headless,
            max(10, min(120, args.timeout)),
        )
        payload = json.dumps(result, ensure_ascii=False)
        write_result_file(args.result_file, payload)
        print(payload)
        return 0
    except Exception as exc:
        payload = json.dumps({"error": str(exc)}, ensure_ascii=False)
        try:
            write_result_file(args.result_file, payload)
        except Exception:
            pass
        print(payload)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

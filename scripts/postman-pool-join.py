#!/usr/bin/env python3
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
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
from threading import Lock
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
ACCOUNT_DISCOVERY_ATTEMPTS = 32
ACCOUNT_CARD_LOOKUP_ATTEMPTS = 20
ACCOUNT_JOIN_ATTEMPTS = 30
ACCOUNT_DISCOVERY_POLL_SECONDS = 0.25
ACCOUNT_CARD_POLL_SECONDS = 0.25
ACCOUNT_JOIN_POLL_SECONDS = 0.35
ACCOUNT_SYNC_SECONDS = 1.0
VERIFY_SETTLE_SECONDS = 0.35
AUTOMATION_WORKERS = 8
RETRY_WORKERS = 2
TRANSIENT_JOIN_ERRORS = (
    "No signed-in Postman account card was found",
    "Postman account card was not found after returning",
    "Postman did not reach a confirmed team page",
    "Postman showed join confirmation but did not complete",
)
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


def pool_name_from_url(url: str | None) -> str | None:
    if not url:
        return None
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return None
    suffix = ".postman.co"
    if not host.endswith(suffix):
        return None
    prefix = host[: -len(suffix)]
    if not prefix or prefix in {"go", "web"}:
        return None
    return prefix


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
    options.page_load_strategy = "eager"
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
        WebDriverWait(driver, min(timeout, 8)).until(lambda current: current.execute_script("return document.readyState") in ("interactive", "complete"))
    except Exception:
        pass


def discover_account_cards(driver, attempts: int = ACCOUNT_DISCOVERY_ATTEMPTS, poll_seconds: float = ACCOUNT_DISCOVERY_POLL_SECONDS) -> dict | None:
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


def find_account_card_href(driver, email: str, attempts: int = ACCOUNT_CARD_LOOKUP_ATTEMPTS, poll_seconds: float = ACCOUNT_CARD_POLL_SECONDS) -> str | None:
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


def safe_transition_diagnostic(driver, url: str | None, body: str, title: str, last_action: str | None) -> dict:
    parsed = urlparse(url or "")
    lowered = f"{title}\n{body}".lower()
    if security_verification_signal(url or "", body, title):
        classification = "challenge"
    elif team_destination_signal(url or ""):
        classification = "team_page"
    elif transition_signal(url or ""):
        classification = "auth_redirect"
    elif any(marker in lowered for marker in ("sign in", "log in", "sign up")):
        classification = "signed_out"
    elif any(marker in lowered for marker in ("join team", "accept invite", "invite")):
        classification = "web_invite_accept"
    elif "account" in lowered and ("choose" in lowered or "select" in lowered):
        classification = "identity_chooser"
    else:
        classification = "unknown"
    try:
        _, By, _, _, _ = selenium_modules()
        auth_state = postman_auth_state(driver, By)
    except Exception:
        auth_state = "unknown"
    return {
        "host": parsed.hostname or "",
        "path": parsed.path or "/",
        "classification": classification,
        "title": re.sub(r"\s+", " ", title or "")[:80],
        "lastAction": re.sub(r"\s+", " ", last_action or "")[:80] or None,
        "authState": auth_state,
    }


def transient_join_error(error: str | None) -> bool:
    return any(marker in str(error or "") for marker in TRANSIENT_JOIN_ERRORS)


def resolve_account_card_href(driver, chooser_url: str, email: str, timeout: int, reloads: int = 3) -> str | None:
    # Re-open the account chooser and locate the target account's switch URL robustly. The
    # chooser can re-render its cards slowly after a previous session switch, so reload a few
    # times and reuse the same discovery that captured the hrefs instead of a single probe.
    target = str(email or "").strip().lower()
    for attempt in range(max(1, reloads)):
        try:
            driver.get(chooser_url)
        except Exception:
            pass
        wait_document_ready(driver, timeout)
        discovery = discover_account_cards(driver)
        for card in (discovery or {}).get("accounts") or []:
            href = card.get("href")
            if str(card.get("email") or "").strip().lower() == target and isinstance(href, str) and href.startswith("https://"):
                return href
        href = find_account_card_href(driver, email)
        if href:
            return href
    return None


def process_chooser_account(driver, chooser_url: str, account: dict, timeout: int, progress: dict) -> tuple[str, str | None, str | None]:
    _, By, _, _, _ = selenium_modules()
    email = str(account.get("email") or "").strip()
    if not email:
        return "failed", "Postman account card has no email", None

    known_href = account.get("href")
    if isinstance(known_href, str) and known_href.startswith("https://"):
        card_href = known_href
    else:
        card_href = resolve_account_card_href(driver, chooser_url, email, timeout)
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
    last_action = None
    body = ""
    title = ""
    for attempt in range(ACCOUNT_JOIN_ATTEMPTS):
        if attempt:
            time.sleep(ACCOUNT_JOIN_POLL_SECONDS)
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
            last_action = str(step.get("clicked"))
            emit_progress({"type": "account_status", "status": "auto_clicked", "clicked": last_action[:80], "email": email, **progress})
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

    diagnostic = safe_transition_diagnostic(driver, final_url, body, title, last_action)
    diagnostic_text = json.dumps(diagnostic, ensure_ascii=False, separators=(",", ":"))
    emit_progress({"type": "transition_diagnostic", "email": email, "diagnostic": diagnostic, **progress})
    if challenge_seen:
        return "failed", f"Postman security challenge did not clear automatically before the join timeout; diagnostic={diagnostic_text}", final_url
    if join_confirmation_seen:
        return "failed", f"Postman showed join confirmation but did not complete the team transition; diagnostic={diagnostic_text}", final_url
    return "failed", f"Postman did not reach a confirmed team page after automatic account switch/accept; diagnostic={diagnostic_text}", final_url


def discover_rows(profiles_root: Path, profile_directories: list[str], scratch_root: Path) -> list[dict]:
    with tempfile.TemporaryDirectory(prefix="places-", dir=scratch_root) as temp_name:
        temp_dir = Path(temp_name)
        rows = []
        for index, dir_name in enumerate(firefox_profile_directories(profiles_root, profile_directories)):
            profile = profiles_root / dir_name
            inventory = profile_session_inventory(profile)
            has_session = bool(inventory["postmanOrigins"]) or "cookies.sqlite" in inventory["files"]
            rows.append({
                "profile": profile_display_name(dir_name),
                "dir": dir_name,
                "path": str(profile),
                "email": places_email(profile, temp_dir, index),
                "hasPostmanSession": has_session,
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
    started = time.perf_counter()
    _, By, _, _, _ = selenium_modules()
    profiles = discover_rows(profiles_root, profile_directories, scratch_root)
    if not profiles:
        raise RuntimeError("no LibreWolf profiles found")
    jobs = []
    for row in profiles:
        inventory = profile_session_inventory(Path(row["path"]))
        if not row.get("email") and not inventory["postmanOrigins"] and "cookies.sqlite" not in inventory["files"]:
            continue
        jobs.append((row, inventory))
    if not jobs:
        raise RuntimeError("no configured Postman profiles found")
    total = len(jobs)
    workers = min(AUTOMATION_WORKERS, total)

    def verify_profile(index: int, row: dict, inventory: dict) -> tuple[int, dict]:
        emit_progress({"type": "verify_start", "index": index, "total": total, "profile": row["profile"], "email": row.get("email")})
        entry = {
            "profile": row["profile"],
            "email": row.get("email"),
            "sessionFiles": inventory["files"],
            "postmanOrigins": inventory["postmanOrigins"],
        }
        driver = None
        try:
            log(f"[postman-pool] verify {row['profile']} -> {row.get('email') or 'email unknown'}")
            driver = firefox_driver(binary, Path(row["path"]), True, min(timeout, 15), scratch_root)
            try:
                driver.get(verify_url)
            except Exception:
                pass
            wait_document_ready(driver, timeout)
            if VERIFY_SETTLE_SECONDS:
                time.sleep(VERIFY_SETTLE_SECONDS)
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
        emit_progress({"type": "verify_done", "index": index, "total": total, **entry})
        return index, entry

    results_by_index: dict[int, dict] = {}
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="postman-verify") as executor:
        futures = [executor.submit(verify_profile, index, row, inventory) for index, (row, inventory) in enumerate(jobs, 1)]
        for future in as_completed(futures):
            index, entry = future.result()
            results_by_index[index] = entry
    results = [results_by_index[index] for index in range(1, total + 1)]
    return {"verifyUrl": verify_url, "headless": True, "workers": workers, "elapsedSeconds": round(time.perf_counter() - started, 3), "results": results}


def email_sort_key(email: str) -> tuple:
    return tuple(int(part) if part.isdigit() else part for part in re.split(r"(\d+)", email.casefold()))


def write_joined_emails(rows: list[dict]) -> Path:
    target = Path.home() / ".aki" / "mcpsv" / "postman-emails.txt"
    target.parent.mkdir(parents=True, exist_ok=True)
    emails = sorted({row["email"] for row in rows if row.get("email")}, key=email_sort_key)
    target.write_text("\n".join(emails) + ("\n" if emails else ""), encoding="utf-8")
    return target


def run(invite_url: str, profiles_root: Path, binary: Path, profile_directories: list[str], scratch_root: Path, headless: bool, timeout: int) -> dict:
    started = time.perf_counter()
    if not valid_invite_url(invite_url):
        raise RuntimeError("not a recognized Postman invite URL")
    chooser_url = account_chooser_url(invite_url)
    profiles = discover_rows(profiles_root, profile_directories, scratch_root)
    if not profiles:
        raise RuntimeError("no LibreWolf profiles found")

    known_emails = {str(row.get("email") or "").lower() for row in profiles if row.get("email")}
    baseline_total = len(known_emails) or len(profiles)
    main_email = next((str(row["email"]).lower() for row in profiles if row.get("email") and row["profile"].casefold() == "default-default"), None)
    if not main_email:
        main_email = next((str(row["email"]).lower() for row in profiles if row.get("email")), None)

    seen_emails: set[str] = set()
    seen_lock = Lock()
    progress_lock = Lock()
    pool_lock = Lock()
    progress_index = 0
    pool_name: str | None = None

    def reserve_accounts(accounts: list[dict]) -> list[dict]:
        unique_accounts = []
        with seen_lock:
            for account in accounts:
                email = str(account.get("email") or "").strip().lower()
                if not email or email in seen_emails:
                    continue
                seen_emails.add(email)
                unique_accounts.append({**account, "email": email})
        return unique_accounts

    def next_index() -> int:
        nonlocal progress_index
        with progress_lock:
            progress_index += 1
            return progress_index

    def current_total() -> int:
        with seen_lock:
            return max(baseline_total, len(seen_emails))

    def process_profile(profile_order: int, row: dict) -> dict:
        nonlocal pool_name
        profile_name = row["profile"]
        local_joined: list[dict] = []
        local_skipped: list[dict] = []
        local_failed: list[dict] = []
        driver = None
        try:
            inventory = profile_session_inventory(Path(row["path"]))
            if not row.get("email") and not inventory["postmanOrigins"] and "cookies.sqlite" not in inventory["files"]:
                emit_progress({"type": "profile_skipped", "profile": profile_name, "reason": "no_postman_session"})
                return {"joined": local_joined, "skipped": local_skipped, "failed": local_failed}
            log(f"[postman-pool] chooser scan {profile_name} -> {row.get('email') or 'email unknown'}")
            driver = firefox_driver(binary, Path(row["path"]), headless, min(timeout, 20), scratch_root)
            try:
                driver.get(chooser_url)
            except Exception:
                pass
            wait_document_ready(driver, timeout)
            discovery = discover_account_cards(driver)
            accounts = list(discovery.get("accounts") or []) if discovery else []
            unique_accounts = reserve_accounts(accounts)

            if accounts and not unique_accounts:
                emit_progress({"type": "profile_skipped", "profile": profile_name, "reason": "duplicate_accounts"})
                return {"joined": local_joined, "skipped": local_skipped, "failed": local_failed}
            if not unique_accounts:
                if not row.get("email"):
                    emit_progress({"type": "profile_skipped", "profile": profile_name, "reason": "no_identified_account"})
                    return {"joined": local_joined, "skipped": local_skipped, "failed": local_failed}
                index = next_index()
                result = {
                    "profile": profile_name,
                    "email": str(row.get("email")).lower(),
                    "status": "failed",
                    "error": "No signed-in Postman account card was found for this LibreWolf profile",
                    "_profileOrder": profile_order,
                    "_accountOrder": 0,
                }
                emit_progress({"type": "account_start", "index": index, "total": current_total(), "profile": profile_name, "email": result["email"]})
                emit_progress({"type": "account_done", "index": index, "total": current_total(), **{key: value for key, value in result.items() if not key.startswith("_")}})
                local_failed.append(result)
                return {"joined": local_joined, "skipped": local_skipped, "failed": local_failed}

            emit_progress({
                "type": "accounts_discovered",
                "profile": profile_name,
                "teamName": (discovery or {}).get("teamName") or "",
                "count": len(unique_accounts),
                "total": current_total(),
                "accounts": [{"email": account.get("email"), "name": account.get("name") or ""} for account in unique_accounts],
            })

            for account_order, account in enumerate(unique_accounts):
                index = next_index()
                email = account.get("email")
                base = {"profile": profile_name, "email": email, "name": account.get("name") or ""}
                emit_progress({"type": "account_start", "index": index, "total": current_total(), **base})
                status, error, final_url = process_chooser_account(driver, chooser_url, account, timeout, {"profile": profile_name})
                candidate_pool = pool_name_from_url(final_url)
                if candidate_pool:
                    with pool_lock:
                        if not pool_name:
                            pool_name = candidate_pool
                result = {**base, "status": status, "_profileOrder": profile_order, "_accountOrder": account_order, "_href": account.get("href")}
                if error:
                    result["error"] = error
                if status in ("joined", "already_joined"):
                    local_joined.append(result)
                elif status == "skipped":
                    local_skipped.append(result)
                else:
                    local_failed.append(result)
                emit_progress({"type": "account_done", "index": index, "total": current_total(), **{key: value for key, value in result.items() if not key.startswith("_")}})
        except Exception as exc:
            if row.get("email"):
                index = next_index()
                result = {
                    "profile": profile_name,
                    "email": str(row.get("email")).lower(),
                    "status": "failed",
                    "error": str(exc),
                    "_profileOrder": profile_order,
                    "_accountOrder": 0,
                }
                local_failed.append(result)
                emit_progress({"type": "account_done", "index": index, "total": current_total(), **{key: value for key, value in result.items() if not key.startswith("_")}})
        finally:
            close_firefox(driver)
        return {"joined": local_joined, "skipped": local_skipped, "failed": local_failed}

    workers = min(AUTOMATION_WORKERS, len(profiles))
    merged = {"joined": [], "skipped": [], "failed": []}
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="postman-join") as executor:
        futures = [executor.submit(process_profile, index, row) for index, row in enumerate(profiles)]
        for future in as_completed(futures):
            profile_result = future.result()
            for group in merged:
                merged[group].extend(profile_result[group])

    profile_by_name = {row["profile"]: row for row in profiles}
    retry_candidates = [row for row in merged["failed"] if transient_join_error(row.get("error"))]

    def retry_account(candidate: dict) -> tuple[dict, dict]:
        nonlocal pool_name
        profile_name = candidate.get("profile")
        email = str(candidate.get("email") or "").strip().lower()
        replacement = dict(candidate)
        driver = None
        emit_progress({"type": "retry_start", "profile": profile_name, "email": email})
        try:
            source = profile_by_name.get(profile_name)
            if not source:
                raise RuntimeError("LibreWolf profile was not found for retry")
            driver = firefox_driver(binary, Path(source["path"]), headless, min(timeout, 20), scratch_root)
            status, error, final_url = process_chooser_account(
                driver,
                chooser_url,
                {"email": email, "name": candidate.get("name") or "", "href": candidate.get("_href")},
                timeout,
                {"profile": profile_name, "retry": 1},
            )
            replacement["status"] = status
            if error:
                replacement["error"] = error
            else:
                replacement.pop("error", None)
            candidate_pool = pool_name_from_url(final_url)
            if candidate_pool:
                with pool_lock:
                    if not pool_name:
                        pool_name = candidate_pool
        except Exception as exc:
            replacement["status"] = "failed"
            replacement["error"] = str(exc)
        finally:
            close_firefox(driver)
        emit_progress({
            "type": "retry_done",
            "profile": profile_name,
            "email": email,
            "status": replacement.get("status"),
            "error": replacement.get("error"),
        })
        return candidate, replacement

    if retry_candidates:
        retry_workers = min(RETRY_WORKERS, len(retry_candidates))
        replacements: list[tuple[dict, dict]] = []
        with ThreadPoolExecutor(max_workers=retry_workers, thread_name_prefix="postman-join-retry") as executor:
            futures = [executor.submit(retry_account, candidate) for candidate in retry_candidates]
            for future in as_completed(futures):
                replacements.append(future.result())
        for original, replacement in replacements:
            if original in merged["failed"]:
                merged["failed"].remove(original)
            target = "joined" if replacement.get("status") in ("joined", "already_joined") else "failed"
            merged[target].append(replacement)

    for group in merged:
        merged[group].sort(key=lambda row: (row.get("_profileOrder", 999), row.get("_accountOrder", 999)))
        for row in merged[group]:
            row.pop("_profileOrder", None)
            row.pop("_accountOrder", None)
            row.pop("_href", None)

    account_rows: dict[str, dict] = {}
    for group in ("joined", "skipped", "failed"):
        for row in merged[group]:
            email = str(row.get("email") or "").strip().lower()
            if email and email not in account_rows:
                account_rows[email] = {"email": email, "status": row.get("status") or group.rstrip("ed")}
    ordered_emails = sorted(account_rows, key=email_sort_key)
    if main_email and main_email in account_rows:
        ordered_emails.remove(main_email)
        ordered_emails.insert(0, main_email)
    accounts = [account_rows[email] for email in ordered_emails]
    email_file = write_joined_emails(merged["joined"])
    return {
        **merged,
        "poolName": pool_name,
        "accountCount": len(accounts),
        "mainEmail": main_email,
        "accounts": accounts,
        "workers": workers,
        "elapsedSeconds": round(time.perf_counter() - started, 3),
        "emailFile": str(email_file),
    }


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

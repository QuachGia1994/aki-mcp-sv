#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "postman-pool-join.py"
SPEC = importlib.util.spec_from_file_location("postman_pool_join", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class PostmanJoinVerificationTests(unittest.TestCase):
    def test_postman_app_destination_requires_official_application_host(self):
        self.assertTrue(MODULE.postman_app_destination("https://go.postman.co/workspace/example"))
        self.assertTrue(MODULE.postman_app_destination("https://web.postman.co/home"))
        self.assertTrue(MODULE.postman_app_destination("https://forever30d.postman.co/"))
        self.assertFalse(MODULE.postman_app_destination("https://example.com/team"))
        self.assertFalse(MODULE.postman_app_destination("https://www.postman.com/"))
        self.assertFalse(MODULE.postman_app_destination("https://identity.getpostman.com/login"))
        self.assertFalse(MODULE.postman_app_destination("https://app.getpostman.com/join-team?invite_code=secret"))

    def test_joined_signal_is_explicit_and_welcome_copy_is_not_enough(self):
        self.assertTrue(MODULE.joined_signal("You joined the team"))
        self.assertTrue(MODULE.joined_signal("You are already a member of this team"))
        self.assertFalse(MODULE.joined_signal("Welcome to Postman"))

    def test_invite_failure_signal_catches_known_postman_errors_and_login(self):
        self.assertTrue(MODULE.invite_failure_signal("Sorry! You seem to have an invalid or expired invite code!"))
        self.assertTrue(MODULE.invite_failure_signal("Unable to join the team"))
        self.assertTrue(MODULE.invite_failure_signal("Sign in to Postman"))
        self.assertFalse(MODULE.invite_failure_signal("You joined the team"))

    def test_security_verification_signal_only_matches_postman_challenge_pages(self):
        body = "Performing security verification. This website verifies you are not a bot."
        self.assertTrue(MODULE.security_verification_signal("https://identity.getpostman.com/login", body, "Just a moment..."))
        self.assertFalse(MODULE.security_verification_signal("https://identity.getpostman.com/login", "Sign in to Postman", "Postman"))
        self.assertFalse(MODULE.security_verification_signal("https://example.com/", body, "Just a moment..."))

    def test_account_chooser_url_matches_author_identity_chain(self):
        invite = "https://app.getpostman.com/join-team?invite_code=abcdefghijklmnop"
        chooser = MODULE.account_chooser_url(invite)
        self.assertTrue(chooser.startswith("https://identity.getpostman.com/accounts?cta=join-team"))
        self.assertIn("invite_code=abcdefghijklmnop", chooser)
        self.assertIn("continue=https%3A%2F%2Fapp.getpostman.com%2Fweb-invite-accept%3Finvite_code%3Dabcdefghijklmnop", chooser)
        self.assertEqual(MODULE.invite_code_from_url(invite), "abcdefghijklmnop")

    def test_team_destination_requires_postman_team_domain_not_identity_transition(self):
        self.assertTrue(MODULE.team_destination_signal("https://forever30d.postman.co/workspace/abc"))
        self.assertTrue(MODULE.team_destination_signal("https://forever30d.postman.co/"))
        self.assertTrue(MODULE.team_destination_signal("https://go.postman.co/home"))
        self.assertTrue(MODULE.team_destination_signal("https://web.postman.co/onboarding/team"))
        self.assertFalse(MODULE.team_destination_signal("https://go.postman.co/error"))
        self.assertFalse(MODULE.team_destination_signal("https://postman.co/pricing"))
        self.assertFalse(MODULE.team_destination_signal("https://identity.getpostman.com/accounts/auth/test"))
        self.assertFalse(MODULE.team_destination_signal("https://app.getpostman.com/web-invite-accept?invite_code=x"))
        self.assertTrue(MODULE.transition_signal("https://identity.getpostman.com/accounts/auth/test"))
        self.assertTrue(MODULE.transition_signal("https://app.getpostman.com/web-invite-accept?invite_code=x"))
        self.assertFalse(MODULE.transition_signal("https://example.com/web-invite-accept"))

    def test_join_confirmation_text_without_team_destination_is_not_success(self):
        class By:
            TAG_NAME = "tag"

        class Driver:
            current_url = "about:blank"
            title = "Postman"

            def get(self, url):
                self.current_url = url

            def find_element(self, _by, _name):
                return type("Element", (), {"text": "You joined the team"})()

        original_modules = MODULE.selenium_modules
        original_wait_ready = MODULE.wait_document_ready
        original_find_href = MODULE.find_account_card_href
        original_accept_step = MODULE.automatic_accept_step
        original_dismiss = MODULE.dismiss_keep_separate
        original_attempts = MODULE.ACCOUNT_JOIN_ATTEMPTS
        original_sleep = MODULE.time.sleep
        try:
            MODULE.selenium_modules = lambda: (None, By, None, None, None)
            MODULE.wait_document_ready = lambda *_args: None
            MODULE.find_account_card_href = lambda *_args: "https://identity.getpostman.com/accounts/auth/account-1"
            MODULE.automatic_accept_step = lambda driver: {"url": driver.current_url, "clicked": None, "checked": 0}
            MODULE.dismiss_keep_separate = lambda *_args: False
            MODULE.ACCOUNT_JOIN_ATTEMPTS = 1
            MODULE.time.sleep = lambda *_args: None
            status, error, _ = MODULE.process_chooser_account(
                Driver(),
                "https://identity.getpostman.com/accounts?cta=join-team&invite_code=secret123",
                {"email": "one@example.com"},
                45,
                {"profile": "Hồ sơ 1"},
            )
        finally:
            MODULE.selenium_modules = original_modules
            MODULE.wait_document_ready = original_wait_ready
            MODULE.find_account_card_href = original_find_href
            MODULE.automatic_accept_step = original_accept_step
            MODULE.dismiss_keep_separate = original_dismiss
            MODULE.ACCOUNT_JOIN_ATTEMPTS = original_attempts
            MODULE.time.sleep = original_sleep
        self.assertEqual(status, "failed")
        self.assertIn("transition", error)

    def test_rate_limit_signal_detects_400_and_rate_limit_pages(self):
        self.assertTrue(MODULE.rate_limit_signal("Rate limit exceeded, try again later"))
        self.assertTrue(MODULE.rate_limit_signal("Too many requests"))
        self.assertTrue(MODULE.rate_limit_signal("Error 400", "rate limited"))
        self.assertFalse(MODULE.rate_limit_signal("400 Bad Request"))
        self.assertFalse(MODULE.rate_limit_signal("You joined the team"))

    def test_dismiss_keep_separate_clicks_a_visible_keep_separate_button(self):
        class By:
            XPATH = "xpath"

        class Element:
            def __init__(self, visible):
                self._visible = visible
                self.clicked = False

            def is_displayed(self):
                return self._visible

            def click(self):
                self.clicked = True

        class Driver:
            def __init__(self, element):
                self.element = element

            def find_elements(self, by, _xpath):
                return [self.element] if by == By.XPATH else []

            def execute_script(self, *_args):
                return None

        visible = Element(True)
        self.assertTrue(MODULE.dismiss_keep_separate(Driver(visible), By))
        self.assertTrue(visible.clicked)

        hidden = Element(False)
        self.assertFalse(MODULE.dismiss_keep_separate(Driver(hidden), By))
        self.assertFalse(hidden.clicked)

    def test_automatic_accept_step_uses_author_auto_confirm_result(self):
        class Driver:
            current_url = "https://app.getpostman.com/web-invite-accept?invite_code=x"

            def execute_script(self, script, *_args):
                self.script = script
                return {"url": self.current_url, "clicked": "Accept Invite", "checked": 1}

        driver = Driver()
        result = MODULE.automatic_accept_step(driver)
        self.assertEqual(result["clicked"], "Accept Invite")
        self.assertEqual(result["checked"], 1)
        self.assertIn("sign in with a different account", driver.script)
        self.assertIn("input[type='checkbox']", driver.script)

    def test_firefox_profile_directories_discovers_marked_dirs_and_natural_sorts(self):
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            for name in ("6tnhmkxE.Hồ sơ 2", "3yaMsJLM.Hồ sơ 10", "jn657ouo.default-default"):
                profile = root / name
                profile.mkdir()
                (profile / "prefs.js").write_text("", encoding="utf-8")
            # Directory without a profile marker must be ignored.
            (root / "Crash Reports").mkdir()
            discovered = MODULE.firefox_profile_directories(root)
            self.assertEqual(discovered, ["6tnhmkxE.Hồ sơ 2", "3yaMsJLM.Hồ sơ 10", "jn657ouo.default-default"])

    def test_firefox_profile_directories_filters_by_display_name_or_dir(self):
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            for name in ("6tnhmkxE.Hồ sơ 2", "3yaMsJLM.Hồ sơ 10"):
                profile = root / name
                profile.mkdir()
                (profile / "prefs.js").write_text("", encoding="utf-8")
            self.assertEqual(MODULE.firefox_profile_directories(root, ["Hồ sơ 10"]), ["3yaMsJLM.Hồ sơ 10"])
            self.assertEqual(MODULE.firefox_profile_directories(root, ["6tnhmkxE.Hồ sơ 2"]), ["6tnhmkxE.Hồ sơ 2"])
            with self.assertRaises(RuntimeError):
                MODULE.firefox_profile_directories(root, ["Hồ sơ 99"])

    def test_places_email_reads_email_from_history_without_browser_secrets(self):
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            profile = root / "N4Hx6K1M.Hồ sơ 1"
            scratch = root / "scratch"
            profile.mkdir()
            scratch.mkdir()
            conn = sqlite3.connect(profile / "places.sqlite")
            try:
                conn.execute("CREATE TABLE moz_places (url TEXT, last_visit_date INTEGER)")
                conn.execute("INSERT INTO moz_places(url, last_visit_date) VALUES (?, ?)", ("https://identity.getpostman.com/login?email=libre%40example.com", 10))
                conn.commit()
            finally:
                conn.close()
            self.assertEqual(MODULE.places_email(profile, scratch, 0), "libre@example.com")

    def test_discover_rows_uses_display_name_and_scratch_root(self):
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            scratch = root / "scratch"
            scratch.mkdir()
            captured = []
            original_profiles = MODULE.firefox_profile_directories
            original_email = MODULE.places_email
            try:
                MODULE.firefox_profile_directories = lambda _root, _requested: ["3yaMsJLM.Hồ sơ 10"]
                MODULE.places_email = lambda _profile, temp_dir, _index: captured.append(temp_dir) or "ten@example.com"
                rows = MODULE.discover_rows(root, [], scratch)
            finally:
                MODULE.firefox_profile_directories = original_profiles
                MODULE.places_email = original_email
            self.assertEqual(rows[0]["profile"], "Hồ sơ 10")
            self.assertEqual(rows[0]["dir"], "3yaMsJLM.Hồ sơ 10")
            self.assertEqual(rows[0]["email"], "ten@example.com")
            self.assertEqual(captured[0].parent, scratch.resolve())

    def test_copy_profile_for_automation_copies_only_session_files_and_postman_storage(self):
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            profile = root / "N4Hx6K1M.Hồ sơ 1"
            scratch = root / "scratch"
            profile.mkdir()
            scratch.mkdir()

            # Session-critical files that must be copied.
            for name in ("cookies.sqlite", "key4.db", "cert9.db", "logins.json", "prefs.js"):
                (profile / name).write_text(name, encoding="utf-8")
            # Bulk that must NOT be copied.
            (profile / "places.sqlite").write_text("history", encoding="utf-8")
            (profile / "parent.lock").write_text("lock", encoding="utf-8")
            (profile / "cache2").mkdir()
            (profile / "cache2" / "big.bin").write_text("x" * 1000, encoding="utf-8")
            # Web storage: Postman origin kept, other origin dropped.
            pm_ls = profile / "storage" / "default" / "https+++go.postman.co" / "ls"
            pm_ls.mkdir(parents=True)
            (pm_ls / "data.sqlite").write_text("token", encoding="utf-8")
            other_ls = profile / "storage" / "default" / "https+++accounts.google.com" / "ls"
            other_ls.mkdir(parents=True)
            (other_ls / "data.sqlite").write_text("nope", encoding="utf-8")
            (profile / "storage" / "ls-archive.sqlite").write_text("arch", encoding="utf-8")

            copy = MODULE.copy_profile_for_automation(profile, scratch)
            self.assertTrue(copy.is_dir())
            self.assertEqual(copy.parent.parent, scratch.resolve())

            for name in ("cookies.sqlite", "key4.db", "cert9.db", "logins.json", "prefs.js"):
                self.assertTrue((copy / name).is_file(), name)
            self.assertFalse((copy / "places.sqlite").exists())
            self.assertFalse((copy / "parent.lock").exists())
            self.assertFalse((copy / "cache2").exists())
            self.assertTrue((copy / "storage" / "default" / "https+++go.postman.co" / "ls" / "data.sqlite").is_file())
            self.assertFalse((copy / "storage" / "default" / "https+++accounts.google.com").exists())
            self.assertTrue((copy / "storage" / "ls-archive.sqlite").is_file())

    def test_postman_auth_state_classifies_pages(self):
        class By:
            TAG_NAME = "tag"

        class Driver:
            def __init__(self, url, body, title=""):
                self.current_url = url
                self._body = body
                self.title = title

            def find_element(self, _by, _name):
                return type("Element", (), {"text": self._body})()

        self.assertEqual(MODULE.postman_auth_state(Driver("https://go.postman.co/home", "My Workspaces"), By), "authenticated")
        self.assertEqual(MODULE.postman_auth_state(Driver("https://forever30d.postman.co/", "My Workspaces"), By), "authenticated")
        self.assertEqual(MODULE.postman_auth_state(Driver("https://identity.getpostman.com/login", "Sign in to Postman", "Sign in"), By), "not_signed_in")
        self.assertEqual(
            MODULE.postman_auth_state(Driver("https://identity.getpostman.com/login", "Performing security verification. This website verifies you are not a bot.", "Just a moment..."), By),
            "cloudflare_challenge",
        )

    def test_profile_session_inventory_lists_present_files_and_postman_origins(self):
        with tempfile.TemporaryDirectory() as temp_name:
            profile = Path(temp_name) / "N4Hx6K1M.Hồ sơ 1"
            profile.mkdir()
            for name in ("cookies.sqlite", "key4.db", "prefs.js"):
                (profile / name).write_text(name, encoding="utf-8")
            (profile / "storage" / "default" / "https+++go.postman.co").mkdir(parents=True)
            (profile / "storage" / "default" / "https+++accounts.google.com").mkdir(parents=True)
            inventory = MODULE.profile_session_inventory(profile)
            self.assertIn("cookies.sqlite", inventory["files"])
            self.assertIn("key4.db", inventory["files"])
            self.assertIn("prefs.js", inventory["files"])
            self.assertNotIn("logins.json", inventory["files"])
            self.assertIn("default/https+++go.postman.co", inventory["postmanOrigins"])
            self.assertFalse(any("google" in origin for origin in inventory["postmanOrigins"]))

    def test_run_ports_account_chooser_per_profile_and_emits_automatic_progress(self):
        rows = [
            {"profile": "Hồ sơ 1", "email": "one@example.com", "path": "C:/p1"},
            {"profile": "Hồ sơ 2", "email": "two@example.com", "path": "C:/p2"},
        ]
        events = []

        class Driver:
            def __init__(self, path):
                self.path = str(path)
                self.current_url = "about:blank"

            def get(self, url):
                self.current_url = url

        original_discover_rows = MODULE.discover_rows
        original_firefox_driver = MODULE.firefox_driver
        original_wait_ready = MODULE.wait_document_ready
        original_discover_cards = MODULE.discover_account_cards
        original_process = MODULE.process_chooser_account
        original_close = MODULE.close_firefox
        original_write = MODULE.write_joined_emails
        original_emit = MODULE.emit_progress
        try:
            MODULE.discover_rows = lambda *_args: rows
            MODULE.firefox_driver = lambda _binary, profile, *_args: Driver(profile)
            MODULE.wait_document_ready = lambda *_args: None
            MODULE.discover_account_cards = lambda driver: {
                "accounts": [{"email": "one@example.com" if driver.path.endswith("p1") else "two@example.com", "name": "Account", "href": "https://identity.getpostman.com/accounts/auth/test"}],
                "teamName": "Pool Team",
            }
            MODULE.process_chooser_account = lambda _driver, _chooser, account, *_args: (("joined", None, "https://team.postman.co/home") if account["email"].startswith("one") else ("failed", "boom", "https://identity.getpostman.com/login"))
            MODULE.close_firefox = lambda _driver: None
            MODULE.write_joined_emails = lambda _rows: Path("emails.txt")
            MODULE.emit_progress = lambda event: events.append(event)
            result = MODULE.run(
                "https://app.getpostman.com/join-team?invite_code=abc1234567890123",
                Path("profiles"),
                Path("librewolf"),
                [],
                Path("scratch"),
                False,
                45,
            )
        finally:
            MODULE.discover_rows = original_discover_rows
            MODULE.firefox_driver = original_firefox_driver
            MODULE.wait_document_ready = original_wait_ready
            MODULE.discover_account_cards = original_discover_cards
            MODULE.process_chooser_account = original_process
            MODULE.close_firefox = original_close
            MODULE.write_joined_emails = original_write
            MODULE.emit_progress = original_emit
        self.assertEqual([event["type"] for event in events], ["accounts_discovered", "account_start", "account_done", "accounts_discovered", "account_start", "account_done"])
        self.assertEqual(events[1]["email"], "one@example.com")
        self.assertEqual(events[2]["status"], "joined")
        self.assertEqual(events[-1]["status"], "failed")
        self.assertEqual(len(result["joined"]), 1)
        self.assertEqual(len(result["failed"]), 1)
        self.assertNotIn("manualAccept", result)
        self.assertFalse(any("url" in event for event in events))
        self.assertFalse(any("url" in item for group in ("joined", "failed", "skipped") for item in result[group]))
        self.assertNotIn("abc1234567890123", repr(events))
        self.assertNotIn("abc1234567890123", repr(result))

    def test_run_skips_profiles_when_account_chooser_only_contains_already_processed_accounts(self):
        rows = [
            {"profile": "Hồ sơ 1", "email": "one@example.com", "path": "C:/p1"},
            {"profile": "Hồ sơ 2", "email": "one@example.com", "path": "C:/p2"},
        ]
        events = []

        class Driver:
            current_url = "about:blank"

            def get(self, url):
                self.current_url = url

        original_discover_rows = MODULE.discover_rows
        original_firefox_driver = MODULE.firefox_driver
        original_wait_ready = MODULE.wait_document_ready
        original_discover_cards = MODULE.discover_account_cards
        original_process = MODULE.process_chooser_account
        original_close = MODULE.close_firefox
        original_write = MODULE.write_joined_emails
        original_emit = MODULE.emit_progress
        try:
            MODULE.discover_rows = lambda *_args: rows
            MODULE.firefox_driver = lambda *_args: Driver()
            MODULE.wait_document_ready = lambda *_args: None
            MODULE.discover_account_cards = lambda _driver: {
                "accounts": [{"email": "one@example.com", "name": "Account", "href": "https://identity.getpostman.com/accounts/auth/test"}],
                "teamName": "Pool Team",
            }
            MODULE.process_chooser_account = lambda *_args: ("joined", None, "https://team.postman.co/home")
            MODULE.close_firefox = lambda _driver: None
            MODULE.write_joined_emails = lambda _rows: Path("emails.txt")
            MODULE.emit_progress = lambda event: events.append(event)
            result = MODULE.run(
                "https://app.getpostman.com/join-team?invite_code=abc1234567890123",
                Path("profiles"),
                Path("librewolf"),
                [],
                Path("scratch"),
                False,
                45,
            )
        finally:
            MODULE.discover_rows = original_discover_rows
            MODULE.firefox_driver = original_firefox_driver
            MODULE.wait_document_ready = original_wait_ready
            MODULE.discover_account_cards = original_discover_cards
            MODULE.process_chooser_account = original_process
            MODULE.close_firefox = original_close
            MODULE.write_joined_emails = original_write
            MODULE.emit_progress = original_emit
        self.assertEqual(len(result["joined"]), 1)
        self.assertEqual(result["failed"], [])
        self.assertIn("profile_skipped", [event["type"] for event in events])

    def test_detached_child_argv_drops_detach_and_targets_this_worker(self):
        argv = ["postman-pool-join.py", "--invite", "https://x", "--detach", "--result-file", "r.json"]
        child = MODULE.detached_child_argv(argv)
        self.assertNotIn("--detach", child)
        self.assertIn("--result-file", child)
        self.assertIn("--invite", child)
        self.assertEqual(child[1], MODULE.os.path.abspath(MODULE.__file__))

    def test_write_result_file_writes_payload_atomically(self):
        with tempfile.TemporaryDirectory() as temp_name:
            target = Path(temp_name) / "nested" / "result.json"
            MODULE.write_result_file(str(target), '{"ok": true}')
            self.assertEqual(target.read_text(encoding="utf-8"), '{"ok": true}')
            self.assertEqual(list(target.parent.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()

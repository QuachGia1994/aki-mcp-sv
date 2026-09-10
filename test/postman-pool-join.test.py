#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "postman-pool-join.py"
SPEC = importlib.util.spec_from_file_location("postman_pool_join", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class PostmanJoinVerificationTests(unittest.TestCase):
    def test_postman_app_destination_requires_official_application_host(self):
        self.assertTrue(MODULE.postman_app_destination("https://go.postman.co/workspace/example"))
        self.assertTrue(MODULE.postman_app_destination("https://web.postman.co/home"))
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

    def test_security_verification_wait_keeps_same_driver_and_resumes_after_human_clears_it(self):
        class By:
            TAG_NAME = "tag"

        class Driver:
            current_url = "https://identity.getpostman.com/login"
            title = "Just a moment..."

            def __init__(self):
                self.reads = 0

            def find_element(self, _by, _name):
                self.reads += 1
                text = "Performing security verification. This website verifies you are not a bot." if self.reads == 1 else "Postman invite ready"
                return type("Element", (), {"text": text})()

        events = []
        original_emit = MODULE.emit_progress
        MODULE.emit_progress = lambda event: events.append(event)
        try:
            driver = Driver()
            self.assertTrue(MODULE.wait_for_security_verification(driver, By, 1, {"profile": "Hồ sơ 1"}, poll_seconds=0))
        finally:
            MODULE.emit_progress = original_emit
        self.assertEqual(driver.reads, 2)
        self.assertEqual([event["type"] for event in events], ["manual_verification_required", "manual_verification_resolved"])

    def test_chrome_profile_directories_use_local_state_and_explicit_filter(self):
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            (root / "Default").mkdir()
            (root / "Profile 1").mkdir()
            (root / "System Profile").mkdir()
            (root / "Local State").write_text(json.dumps({"profile": {"info_cache": {"Default": {"name": "Main"}, "Profile 1": {"name": "Pool 2"}, "System Profile": {"name": "System"}}}}), encoding="utf-8")
            self.assertEqual(MODULE.chrome_profile_directories(root), ["Default", "Profile 1"])
            self.assertEqual(MODULE.chrome_profile_directories(root, ["Profile 1"]), ["Profile 1"])

    def test_chrome_user_data_root_must_not_be_default_profile_root(self):
        with tempfile.TemporaryDirectory() as temp_name:
            local = Path(temp_name)
            with patch.dict(MODULE.os.environ, {"LOCALAPPDATA": str(local)}):
                self.assertTrue(MODULE.is_default_chrome_user_data_root(local / "Google" / "Chrome" / "User Data"))
                self.assertFalse(MODULE.is_default_chrome_user_data_root(local / "Aki" / "Postman Chrome"))

    def test_chrome_identity_history_reads_email_without_browser_secrets(self):
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            profile = root / "Profile 1"
            scratch = root / "scratch"
            profile.mkdir()
            scratch.mkdir()
            conn = sqlite3.connect(profile / "History")
            try:
                conn.execute("CREATE TABLE urls (url TEXT, last_visit_time INTEGER)")
                conn.execute("INSERT INTO urls(url, last_visit_time) VALUES (?, ?)", ("https://identity.getpostman.com/login?email=chrome%40example.com", 10))
                conn.commit()
            finally:
                conn.close()
            self.assertEqual(MODULE.chrome_identity_history_email(profile, scratch, 0), "chrome@example.com")

    def test_cdp_click_dispatches_normal_pointer_events_at_element_center(self):
        class Driver:
            def __init__(self):
                self.commands = []

            def execute_script(self, _script, _element):
                return {"x": 10, "y": 20, "width": 40, "height": 20}

            def execute_cdp_cmd(self, method, payload):
                self.commands.append((method, payload))

        driver = Driver()
        MODULE.cdp_click_element(driver, object())
        self.assertEqual([payload["type"] for _, payload in driver.commands], ["mouseMoved", "mousePressed", "mouseReleased"])
        self.assertTrue(all(method == "Input.dispatchMouseEvent" for method, _ in driver.commands))
        self.assertTrue(all(payload["x"] == 30 and payload["y"] == 30 for _, payload in driver.commands))

    def test_profile_identity_temp_stays_under_supplied_scratch_root(self):
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            profile = root / "Profile 1"
            scratch = root / "scratch"
            profile.mkdir()
            scratch.mkdir()
            captured = []
            original_profiles = MODULE.preferred_profiles
            original_email = MODULE.profile_email
            try:
                MODULE.preferred_profiles = lambda _root: [("Profile 1", profile)]
                MODULE.profile_email = lambda _profile, temp_dir, _index: captured.append(temp_dir) or "one@example.com"
                rows = MODULE.discover_rows(root, scratch)
            finally:
                MODULE.preferred_profiles = original_profiles
                MODULE.profile_email = original_email
            self.assertEqual(rows[0]["email"], "one@example.com")
            self.assertEqual(captured[0].parent, scratch.resolve())


if __name__ == "__main__":
    unittest.main()

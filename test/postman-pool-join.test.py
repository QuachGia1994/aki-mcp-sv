#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path
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

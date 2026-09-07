#!/usr/bin/env python3
from __future__ import annotations

import asyncio
from contextlib import redirect_stdout
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "postman-pool-telegram.py"
SPEC = importlib.util.spec_from_file_location("postman_pool_telegram", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class TextUrl:
    def __init__(self, url: str):
        self.url = url


class OtherEntity:
    url = "https://app.getpostman.com/join-team?invite_code=ignored"


class Message:
    def __init__(self, entities):
        self.entities = entities


class FakeDialog:
    def __init__(self, dialog_id: int, name: str, *, is_group: bool = False, is_channel: bool = False):
        self.id = dialog_id
        self.name = name
        self.is_group = is_group
        self.is_channel = is_channel


class FakeClient:
    async def get_me(self):
        return type("Me", (), {"id": 99, "username": "owner"})()

    async def iter_dialogs(self):
        for dialog in [
            FakeDialog(-100123, "Postman Pool", is_group=True),
            FakeDialog(-100456, "Announcements", is_channel=True),
            FakeDialog(7, "Direct chat"),
        ]:
            yield dialog


class TelethonTransportTests(unittest.TestCase):
    def test_client_settings_accepts_local_session_without_exposing_credentials(self):
        with tempfile.TemporaryDirectory() as temp_name:
            session = Path(temp_name) / "telegram-user.session"
            api_id, api_hash, session_path = MODULE.client_settings({
                "telegramApiId": 123456,
                "telegramApiHash": "secret-hash",
                "telegramSessionPath": str(session),
            })
            self.assertEqual(api_id, 123456)
            self.assertEqual(api_hash, "secret-hash")
            self.assertEqual(session_path, str(session))
            self.assertTrue(session.parent.is_dir())

    def test_client_settings_rejects_incomplete_credentials(self):
        with self.assertRaisesRegex(RuntimeError, "telegramApiId"):
            MODULE.client_settings({"telegramApiId": 123456})

    def test_entity_urls_emits_only_text_link_entities(self):
        rows = MODULE.entity_urls(Message([TextUrl("https://example.com/one"), OtherEntity()]), TextUrl)
        self.assertEqual(rows, [{"type": "text_link", "url": "https://example.com/one"}])

    def test_dialog_discovery_prints_immutable_chat_id_type_and_title(self):
        output = io.StringIO()
        with redirect_stdout(output):
            asyncio.run(MODULE.print_identity_and_dialogs(FakeClient()))
        text = output.getvalue()
        self.assertIn("SELF userId=99 username=@owner", text)
        self.assertIn("chatId=-100123\ttype=group\ttitle=Postman Pool", text)
        self.assertIn("chatId=-100456\ttype=channel\ttitle=Announcements", text)
        self.assertNotIn("Direct chat", text)


if __name__ == "__main__":
    unittest.main()

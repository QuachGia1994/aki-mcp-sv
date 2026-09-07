#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import sys
from pathlib import Path


def telethon_modules():
    try:
        from telethon import TelegramClient, events
        from telethon.tl.types import MessageEntityTextUrl
    except ImportError as exc:
        raise RuntimeError("Telethon is not installed; run `py -3 -m pip install telethon`") from exc
    return TelegramClient, events, MessageEntityTextUrl


def read_json_line() -> dict:
    raw = sys.stdin.readline()
    if not raw:
        raise RuntimeError("listener config JSON is required on stdin")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise RuntimeError("listener config must be an object")
    return value


def read_config(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("postman-pool config must be an object")
    return value


def client_settings(config: dict) -> tuple[int, str, str]:
    api_id = int(config.get("apiId") or config.get("telegramApiId") or 0)
    api_hash = str(config.get("apiHash") or config.get("telegramApiHash") or "").strip()
    session_path = str(config.get("sessionPath") or config.get("telegramSessionPath") or "").strip()
    if api_id <= 0 or not api_hash or not session_path:
        raise RuntimeError("telegramApiId, telegramApiHash, and telegramSessionPath are required")
    path = Path(session_path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    return api_id, api_hash, str(path)


def entity_urls(message, entity_type) -> list[dict]:
    rows: list[dict] = []
    for entity in message.entities or []:
        if isinstance(entity, entity_type) and getattr(entity, "url", None):
            rows.append({"type": "text_link", "url": str(entity.url)})
    return rows


async def watch_json_lines(config: dict) -> int:
    TelegramClient, events, MessageEntityTextUrl = telethon_modules()
    api_id, api_hash, session_path = client_settings(config)
    source_chat_id = int(config.get("sourceChatId") or 0)
    if not source_chat_id:
        raise RuntimeError("sourceChatId is required")
    client = TelegramClient(session_path, api_id, api_hash)
    await client.connect()
    if not await client.is_user_authorized():
        await client.disconnect()
        raise RuntimeError("Telegram user session is not authorized; run this script once with --login")

    @client.on(events.NewMessage(chats=source_chat_id))
    async def on_message(event):
        message = event.message
        payload = {
            "chat": {"id": event.chat_id},
            "from": {"id": event.sender_id},
            "text": message.raw_text or "",
            "entities": entity_urls(message, MessageEntityTextUrl),
        }
        print(json.dumps(payload, ensure_ascii=False), flush=True)

    try:
        await client.run_until_disconnected()
    finally:
        await client.disconnect()
    return 0


async def print_identity_and_dialogs(client) -> None:
    me = await client.get_me()
    print(f"SELF userId={me.id} username=@{me.username or '-'}")
    print("DIALOGS")
    async for dialog in client.iter_dialogs():
        if dialog.is_group or dialog.is_channel:
            kind = "group" if dialog.is_group else "channel"
            print(f"chatId={dialog.id}\ttype={kind}\ttitle={dialog.name}")


async def login_and_list(config: dict) -> int:
    TelegramClient, _, _ = telethon_modules()
    api_id, api_hash, session_path = client_settings(config)
    client = TelegramClient(session_path, api_id, api_hash)
    await client.start(
        phone=lambda: input("Telegram phone (+countrycode...): ").strip(),
        code_callback=lambda: input("Telegram login code: ").strip(),
        password=lambda: getpass.getpass("Telegram 2FA password: "),
    )
    await print_identity_and_dialogs(client)
    await client.disconnect()
    return 0


async def list_dialogs(config: dict) -> int:
    TelegramClient, _, _ = telethon_modules()
    api_id, api_hash, session_path = client_settings(config)
    client = TelegramClient(session_path, api_id, api_hash)
    await client.connect()
    if not await client.is_user_authorized():
        await client.disconnect()
        raise RuntimeError("Telegram user session is not authorized; run this script once with --login")
    try:
        await print_identity_and_dialogs(client)
    finally:
        await client.disconnect()
    return 0


async def observe_senders(config: dict) -> int:
    TelegramClient, events, _ = telethon_modules()
    api_id, api_hash, session_path = client_settings(config)
    source_chat_id = int(config.get("sourceChatId") or 0)
    if not source_chat_id:
        raise RuntimeError("sourceChatId is required before --observe-senders")
    client = TelegramClient(session_path, api_id, api_hash)
    await client.connect()
    if not await client.is_user_authorized():
        await client.disconnect()
        raise RuntimeError("Telegram user session is not authorized; run --login first")

    @client.on(events.NewMessage(chats=source_chat_id))
    async def on_message(event):
        sender = await event.get_sender()
        username = getattr(sender, "username", None) or "-"
        first = getattr(sender, "first_name", None) or ""
        last = getattr(sender, "last_name", None) or ""
        name = " ".join(part for part in (first, last) if part).strip() or "-"
        print(f"senderUserId={event.sender_id}\tusername=@{username}\tname={name}", flush=True)

    print(f"Observing sender IDs in chat {source_chat_id}; Ctrl+C to stop.", flush=True)
    try:
        await client.run_until_disconnected()
    finally:
        await client.disconnect()
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Telegram user-session transport for Postman pool automation")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--json-lines", action="store_true")
    mode.add_argument("--login", action="store_true")
    mode.add_argument("--list-dialogs", action="store_true")
    mode.add_argument("--observe-senders", action="store_true")
    parser.add_argument("--config", type=Path)
    return parser.parse_args()


async def async_main() -> int:
    args = parse_args()
    if args.json_lines:
        config = read_json_line()
        return await watch_json_lines(config)
    if not args.config:
        raise RuntimeError("--config is required with --login/--list-dialogs/--observe-senders")
    config = read_config(args.config.expanduser())
    if args.login:
        return await login_and_list(config)
    if args.list_dialogs:
        return await list_dialogs(config)
    return await observe_senders(config)


def main() -> int:
    # Emit UTF-8 regardless of the Windows console/pipe codepage (e.g. cp1258/cp1252):
    # the JSON line protocol and dialog listings carry non-ASCII text that those codecs
    # cannot encode, and the Node reader already decodes stdout as UTF-8.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    try:
        return asyncio.run(async_main())
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

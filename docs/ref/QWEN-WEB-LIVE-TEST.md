# Qwen Web -> Aki bootstrap

Canonical browser bootstrap for Qwen through `https://aki-bridge.oakgatekeeper.uk`.

Before running, set `BRIDGE_TOKEN` to the Qwen-specific bearer and set `PROJECT` to the absolute Windows project path. Prefer the custom domain over the `workers.dev` hostname because browser/code-sandbox egress to `workers.dev` has previously timed out even when the Worker itself was healthy.

```python
import time
import uuid
import requests

AKI_URL = "https://aki-bridge.oakgatekeeper.uk"
BRIDGE_TOKEN = "PASTE_QWEN_BEARER_HERE"
PROJECT = r"C:\path\to\project"
HEADERS = {"Authorization": f"Bearer {BRIDGE_TOKEN}"}


def aki(tool, arguments=None, timeout=120, idempotency_key=None):
    key = idempotency_key or uuid.uuid4().hex
    payload = {"tool": tool, "arguments": arguments or {}}
    post_headers = {**HEADERS, "Idempotency-Key": key, "Content-Type": "application/json"}
    last_error = None
    for attempt in range(2):
        try:
            response = requests.post(f"{AKI_URL}/v1/tasks", headers=post_headers, json=payload, timeout=15)
            response.raise_for_status()
            task_id = response.json()["id"]
            break
        except requests.exceptions.Timeout as error:
            last_error = error
            if attempt == 1:
                raise
            time.sleep(2)
    else:
        raise last_error

    deadline = time.time() + timeout
    while time.time() < deadline:
        response = requests.get(f"{AKI_URL}/v1/tasks/{task_id}", headers=HEADERS, timeout=15)
        response.raise_for_status()
        data = response.json()
        if data["status"] in ("done", "error"):
            return {"id": task_id, **data}
        time.sleep(2)
    raise TimeoutError(f"Aki task {task_id} did not finish within {timeout}s")

version_check = aki("filesystem__read_text_file", {"path": r"C:\Users\PHONGQK\.aki\akidevrule\.version"})
print("AKI VERSION CHECK:", version_check)
project_check = aki("local__run_cmd", {"command": "git status --short --branch", "cwd": PROJECT})
print("PROJECT ACCESS CHECK:", project_check)
print("AKI BOOTSTRAP COMPLETE")
```

After bootstrap, use the `aki()` helper for all real Windows project access. Use `local__find_path` for discovery, `local__search_content` for source search, filesystem tools for reads/edits/writes, and `local__run_cmd` with `cwd=PROJECT` for Git/tests/builds. Never fall back to Qwen's sandbox filesystem or shell. Retry timed-out task creation only with the same Idempotency-Key.

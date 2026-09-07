const { invoke } = window.__TAURI__.core;

const $ = (selector) => document.querySelector(selector);

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.toggle("active", el.id === `screen-${name}`));
  document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", el.dataset.screen === name));
}

async function runCheck() {
  const out = $("#check-out");
  const btn = $("#check-btn");
  btn.disabled = true;
  out.textContent = "Running environment check\u2026";
  try {
    out.textContent = await invoke("env_check");
  } catch (error) {
    out.textContent = `Environment check failed:\n${error}`;
  } finally {
    btn.disabled = false;
  }
}

async function loadConfig() {
  const out = $("#setup-out");
  try {
    const cfg = JSON.parse(await invoke("get_config"));
    const form = $("#setup-form");
    form.telegramApiId.value = cfg.telegramApiId || "";
    form.sourceChatId.value = cfg.sourceChatId || "";
    form.adminUserIds.value = (cfg.adminUserIds || []).join(", ");
    form.reportChatId.value = cfg.reportChatId || "";
    form.telegramSessionPath.value = cfg.telegramSessionPath || "";
    form.librewolfBinary.value = cfg.librewolfBinary || "";
    form.profileRoot.value = cfg.profileRoot || "";
    form.scratchRoot.value = cfg.scratchRoot || "";
    form.timeoutSeconds.value = cfg.timeoutSeconds || 45;
    form.telegramApiHash.value = "";
    form.reportBotToken.value = "";
    $("#tag-apihash").textContent = cfg.hasApiHash ? "set" : "not set";
    $("#tag-token").textContent = cfg.hasReportBotToken ? `set (${cfg.tokenSource})` : "not set";
    out.textContent = `Loaded config from ${cfg.configPath}`;
  } catch (error) {
    out.textContent = `Load failed:\n${error}`;
  }
}

async function saveConfig(event) {
  event.preventDefault();
  const form = $("#setup-form");
  const out = $("#setup-out");
  const patch = {
    telegramApiId: Number(form.telegramApiId.value) || 0,
    sourceChatId: form.sourceChatId.value.trim(),
    adminUserIds: form.adminUserIds.value.split(",").map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0),
    reportChatId: form.reportChatId.value.trim(),
    telegramSessionPath: form.telegramSessionPath.value.trim(),
    librewolfBinary: form.librewolfBinary.value.trim(),
    profileRoot: form.profileRoot.value.trim(),
    scratchRoot: form.scratchRoot.value.trim(),
    timeoutSeconds: Number(form.timeoutSeconds.value) || 45,
  };
  if (form.telegramApiHash.value.trim()) patch.telegramApiHash = form.telegramApiHash.value.trim();
  if (form.reportBotToken.value.trim()) patch.reportBotToken = form.reportBotToken.value.trim();
  out.textContent = "Saving\u2026";
  try {
    await invoke("save_config", { patch: JSON.stringify(patch) });
    const status = JSON.parse(await invoke("config_status"));
    out.textContent = `Saved. Ready: ${status.ready ? "YES" : "NO"}. Missing: ${status.missing.length ? status.missing.join(", ") : "none"}`;
    await loadConfig();
  } catch (error) {
    out.textContent = `Save failed:\n${error}`;
  }
}

async function launchConsole(command, label) {
  const out = $("#dialogs-out");
  out.textContent = `${label}\u2026`;
  try {
    out.textContent = await invoke(command);
  } catch (error) {
    out.textContent = `${label} failed:\n${error}`;
  }
}

async function listDialogs() {
  const out = $("#dialogs-out");
  const btn = $("#dialogs-btn");
  btn.disabled = true;
  out.textContent = "Listing groups (needs an authorized login first)\u2026";
  try {
    out.textContent = await invoke("list_dialogs");
  } catch (error) {
    out.textContent = `List failed:\n${error}`;
  } finally {
    btn.disabled = false;
  }
}

async function refreshStatus() {
  const out = $("#status-out");
  out.textContent = "Loading\u2026";
  try {
    const s = JSON.parse(await invoke("config_status"));
    out.textContent = [
      `enabled:       ${s.enabled}`,
      `ready:         ${s.ready ? "YES" : "NO"}`,
      `missing:       ${s.missing.length ? s.missing.join(", ") : "none"}`,
      `sourceChatId:  ${s.sourceChatId || "(none)"}`,
      `adminUserIds:  ${(s.adminUserIds || []).join(", ") || "(none)"}`,
      `reportChatId:  ${s.reportChatId || "(none)"}`,
      `token source:  ${s.tokenSource}`,
    ].join("\n");
  } catch (error) {
    out.textContent = `Status failed:\n${error}`;
  }
}

async function sendTest() {
  const out = $("#status-out");
  const btn = $("#test-btn");
  btn.disabled = true;
  out.textContent = "Sending outbound test\u2026";
  try {
    const result = JSON.parse(await invoke("send_test"));
    out.textContent = result.ok
      ? `Test sent to chat ${result.chatId} (token: ${result.tokenSource}); message_id=${result.messageId ?? "n/a"}`
      : `Test failed: ${result.error}`;
  } catch (error) {
    out.textContent = `Test failed:\n${error}`;
  } finally {
    btn.disabled = false;
  }
}

async function setEnabled(enabled) {
  const out = $("#status-out");
  try {
    const status = JSON.parse(await invoke("config_status"));
    if (enabled && !status.ready) {
      out.textContent = `Cannot enable \u2014 missing: ${status.missing.join(", ")}`;
      return;
    }
    await invoke("save_config", { patch: JSON.stringify({ enabled }) });
    await refreshStatus();
    $("#status-out").textContent += `\n\n${enabled ? "Enabled" : "Disabled"}. Restart Aki so the watcher picks up the change.`;
  } catch (error) {
    out.textContent = `Toggle failed:\n${error}`;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      showScreen(tab.dataset.screen);
      if (tab.dataset.screen === "setup") loadConfig();
      if (tab.dataset.screen === "status") refreshStatus();
    });
  });
  $("#check-btn").addEventListener("click", runCheck);
  $("#reload-btn").addEventListener("click", loadConfig);
  $("#setup-form").addEventListener("submit", saveConfig);
  $("#login-btn").addEventListener("click", () => launchConsole("launch_login", "Opening login console"));
  $("#observe-btn").addEventListener("click", () => launchConsole("launch_observe", "Opening observe console"));
  $("#dialogs-btn").addEventListener("click", listDialogs);
  $("#status-btn").addEventListener("click", refreshStatus);
  $("#test-btn").addEventListener("click", sendTest);
  $("#enable-btn").addEventListener("click", () => setEnabled(true));
  $("#disable-btn").addEventListener("click", () => setEnabled(false));
});

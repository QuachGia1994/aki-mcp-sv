#!/usr/bin/env node
const CDP = require('chrome-remote-interface');
const { PostmanSession } = require('./postman-session');

function pageProbe() {
  const all = (selector) => Array.from(document.querySelectorAll(selector));
  const query = (selector) => document.querySelector(selector);
  const text = (element) => ((element && (element.innerText || element.textContent)) || '').trim().slice(0, 100);
  const chatContainer = query('[data-testid="ai-chat-container"]');
  const scanRoot = query('[data-testid="ai-chat-conversation-container"]') || chatContainer || document.body;
  const approvalWord = /^(approve|allow|run|continue|accept|try again|reject|deny)$/i;
  const approvalButtons = Array.from(scanRoot.querySelectorAll('button'))
    .filter((button) => approvalWord.test(((button.getAttribute('aria-label') || button.innerText || button.textContent) || '').trim()))
    .slice(0, 12)
    .map((button) => {
      let card = button.closest('.tool-approval-wrapper, .tool-approval-single-item, .external-mcp-tool-approval, .ai-chat-loop-approval-message, [role="dialog"], [role="alertdialog"]');
      const matchedKnownRoot = !!card;
      if (!card) card = button.parentElement && button.parentElement.parentElement;
      return {
        button: ((button.getAttribute('aria-label') || button.innerText || button.textContent) || '').trim().slice(0, 30),
        matchedKnownRoot,
        cardTag: card && card.tagName.toLowerCase(),
        cardClass: card && (card.getAttribute('class') || '').slice(0, 140),
        cardTestid: card && card.getAttribute('data-testid'),
      };
    });
  const agentKeys = Object.keys(localStorage).filter((key) => /agent|think|autorun|auto-?run|mode/i.test(key));
  const agentLocalStorage = {};
  for (const key of agentKeys) agentLocalStorage[key] = localStorage.getItem(key);
  return {
    url: location.href,
    hasChatContainer: !!chatContainer,
    approvalButtons,
    permissionRoots: {
      toolApprovalWrapper: all('.tool-approval-wrapper').length,
      toolApprovalSingleItem: all('.tool-approval-single-item').length,
      externalMcpToolApproval: all('.external-mcp-tool-approval').length,
      aiChatLoopApprovalMessage: all('.ai-chat-loop-approval-message').length,
      roleDialog: all('[role="dialog"]').length,
      roleAlertDialog: all('[role="alertdialog"]').length,
    },
    settingsButton: !!query('[data-testid="ai-chat-input-settings-button"]'),
    modelMenuButtons: all('[data-testid="aether-menu-button"][aria-haspopup="menu"]').map((button) => text(button)),
    sendButton: !!query('.ai-chat-input-send-button'),
    chatInput: !!query('[data-testid="ai-chat-input-editor"] [contenteditable="true"]'),
    allChatButtons: chatContainer ? Array.from(chatContainer.querySelectorAll('button')).map((button) => ({
      text: text(button),
      testid: button.getAttribute('data-testid'),
      aria: button.getAttribute('aria-label'),
    })) : [],
    agentModeSettingsRaw: localStorage.getItem('agentModeSettings'),
    agentLocalStorageKeys: agentKeys,
    agentLocalStorage,
    stats: window.__pmStats || null,
  };
}

async function main() {
  const port = PostmanSession.getDevToolsPort();
  let targets;
  try {
    targets = await CDP.List({ port });
  } catch (error) {
    console.error(`Cannot reach Postman DevTools on port ${port}: ${error && error.message}`);
    process.exitCode = 1;
    return;
  }

  const pages = targets.filter((target) => target.type === 'page');
  const results = [];
  for (const target of pages) {
    let client;
    try {
      client = await CDP({ target: target.id, port });
      await client.Runtime.enable();
      const { result, exceptionDetails } = await client.Runtime.evaluate({
        expression: `(${pageProbe.toString()})()`,
        returnByValue: true,
      });
      if (exceptionDetails) results.push({ target: target.url, error: exceptionDetails.text });
      else results.push({ target: target.url, probe: result.value });
    } catch (error) {
      results.push({ target: target.url, error: error && error.message });
    } finally {
      if (client) try { await client.close(); } catch {}
    }
  }

  console.log(JSON.stringify({ port, pageTargets: pages.length, chatPages: results.filter((entry) => entry.probe?.hasChatContainer), allPages: results }, null, 2));
}

main().catch((error) => {
  console.error('probe failed:', error && error.message);
  process.exitCode = 1;
});

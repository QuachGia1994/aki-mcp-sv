// Renders the connector config to a local HTML file in data/ (never public/) so credentials never travel over the Funnel.
import { writeFileSync } from 'node:fs';
import os from 'node:os';

const RULES_DIR = `${os.homedir()}/.aki/akidevrule`;
const CLAUDE_DIR = `${os.homedir()}/.claude`;
const MCP_NAME = 'Aki Mac MCPSV Shell & Filesystem';
const SETTINGS_URL = 'https://claude.ai/new#settings/general';
const CONNECTOR_URL = 'https://claude.ai/new?modal=add-custom-connector#settings/customize-connectors';
const TOKENIZER_URL = 'https://chromewebstore.google.com/detail/claude-token-counter/bioobpobpbeohjoefndgkiaakboimpch';
const WIDEN_SNIPPET = "document.querySelectorAll('.max-w-3xl').forEach(el => el.classList.replace('max-w-3xl', 'max-w-7xl'));";

const INSTRUCTION = `LUÔN TRẢ LỜI NGẮN GỌN, CÔ ĐỌNG, ĐÚNG TRỌNG TÂM. KHÔNG BỊA, KHÔNG SUY DIỄN. Khẳng định phải có căn cứ, tìm kiếm phải có chứng cứ.
Đầu mỗi phiên có MCP "${MCP_NAME}", trước khi trả lời: dùng filesystem tool đọc ${CLAUDE_DIR}/CLAUDE.md + ${CLAUDE_DIR}/CLAUDE.local.md (native, như Claude Code) và 4 file rule ${RULES_DIR}/index.md, RULE-agent-behavior.md, RULE-coding.md, RULE-design-core.md, rồi tuân theo cho toàn bộ hội thoại. Router đầy đủ: ${CLAUDE_DIR}/skills/akirule/SKILL.md.
Muốn chạy git/ls/grep trong một repo cụ thể: gọi tool run_cmd kèm tham số cwd (đường dẫn repo dưới /Volumes/DEV), đừng dùng cd hay -C.`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function field(label, value, mono = true) {
  return `<div class="row"><label>${esc(label)}</label><div class="val ${mono ? 'mono' : ''}" data-copy>${esc(value)}</div><button onclick="copyFrom(this)">copy</button></div>`;
}

function block(label, value) {
  return `<div class="blk"><div class="blabel">${esc(label)}<button onclick="copyFrom(this)">copy</button></div><pre data-copy>${esc(value)}</pre></div>`;
}

function render({ url, client, passphrase }) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(MCP_NAME)} — config</title>
<style>
:root { color-scheme: light dark; --bg:#faf9f7; --card:#fff; --line:#e5e2dc; --fg:#1a1a1a; --muted:#6b6b6b; --accent:#ff4800; }
@media (prefers-color-scheme: dark) { :root { --bg:#1a1817; --card:#232120; --line:#38352f; --fg:#ececec; --muted:#9a948c; } }
* { box-sizing: border-box; }
body { font-family: -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--fg); margin: 0; padding: 32px 16px; }
main { max-width: 760px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
p.sub { color: var(--muted); margin: 0 0 24px; font-size: 13px; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 12px; }
.row { display: grid; grid-template-columns: 130px 1fr auto; gap: 10px; align-items: center; margin-bottom: 8px; }
.row label { color: var(--muted); font-size: 13px; }
.val { padding: 8px 10px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; overflow-x: auto; white-space: nowrap; }
.mono { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
button { border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
button:hover { border-color: var(--accent); color: var(--accent); }
.blk { margin-bottom: 12px; }
.blabel { display: flex; justify-content: space-between; align-items: center; color: var(--muted); font-size: 13px; margin-bottom: 6px; }
pre { margin: 0; padding: 10px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
a { color: var(--accent); }
.lnk { font-size: 12px; margin: 0 0 10px; }
@media (max-width: 560px) { .row { grid-template-columns: 1fr; } }
</style></head><body><main>
<h1>${esc(MCP_NAME)}</h1>
<p class="sub">File cục bộ (data/config.html) — không phục vụ qua Funnel. Sinh lại mỗi lần npm start.</p>

<section><h2>Connector (dán vào claude.ai → Add custom connector)</h2>
<p class="lnk"><a href="${CONNECTOR_URL}" target="_blank" rel="noopener">↗ Mở trang Add custom connector</a></p>
${field('MCP Name', MCP_NAME, false)}
${field('MCP URL', url)}
${field('OAuth Client ID', client.clientId)}
${field('OAuth Client Secret', client.clientSecret)}
${field('Passphrase', passphrase)}
</section>

<section><h2>Claude Settings → Instructions</h2>
<p class="lnk"><a href="${SETTINGS_URL}" target="_blank" rel="noopener">↗ Mở Settings → General (Instructions)</a></p>
${block('Prompt (đọc akirule + phong cách)', INSTRUCTION)}
</section>

<section><h2>Tiện ích trình duyệt</h2>
<p style="font-size:13px;margin:0 0 12px">Đếm token: <a href="${esc(TOKENIZER_URL)}" target="_blank" rel="noopener">Claude Token Counter (Chrome extension)</a></p>
${block('Mở rộng khung chat claude.ai (dán vào Console)', WIDEN_SNIPPET)}
</section>
</main>
<script>
function copyFrom(btn) {
  const box = btn.closest('.row, .blk');
  const el = box.querySelector('[data-copy]');
  const text = el.textContent;
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.textContent; btn.textContent = 'copied'; setTimeout(() => (btn.textContent = old), 1200);
  });
}
</script>
</body></html>`;
}

export function writeConfigPage(outFile, { origin, client, passphrase }) {
  writeFileSync(outFile, render({ url: `${origin}/mcp`, client, passphrase }));
}

// Renders the control panel page. Served only by panel.js on loopback — credentials never travel over the Funnel.
import os from 'node:os';

const CLAUDE_DIR = `${os.homedir()}/.claude`;
const MCP_NAME = 'Aki Mac MCPSV Shell & Filesystem';
const SETTINGS_URL = 'https://claude.ai/new#settings/general';
const CONNECTOR_URL = 'https://claude.ai/new?modal=add-custom-connector#settings/customize-connectors';
const TOKENIZER_URL = 'https://chromewebstore.google.com/detail/claude-token-counter/bioobpobpbeohjoefndgkiaakboimpch';
const RULES_REPO_URL = 'https://github.com/lacvietanh/akidevrule';
const RULES_INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/lacvietanh/akidevrule/master/install.sh | bash';
const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';
const TAILSCALE_FUNNEL_URL = 'https://tailscale.com/docs/features/tailscale-funnel';
const WIDEN_SNIPPET = "document.querySelectorAll('.max-w-3xl').forEach(el => el.classList.replace('max-w-3xl', 'max-w-7xl'));";
const DEFAULT_RULES = ['index.md', 'RULE-agent-behavior.md', 'RULE-coding.md', 'RULE-design-core.md'];

// Footer mirrors akitao.com's own — same products, same order, same 20px icons hotlinked from that site — but in this panel's tokens so it follows the light/dark theme.
const SITE = 'https://akitao.com';
const ECOSYSTEM = [
  ['AkiTao.com', 'https://akitao.com', '/pj/icon-akitao.com-96.png'],
  ['TachNhac v1', 'https://tool.akivn.net', '/pj/icon-tachnhacv1-96.png'],
  ['TachNhac.com', 'https://tachnhac.com', '/pj/icon-tachnhac.com-96.png'],
  ['Aki Kinh Dịch', 'https://kinhdich.akinet.me', '/pj/icon-kinhdich.akinet.me-96.png'],
  ['Tử Vi AkiNet', 'https://tuvi.akinet.me', '/pj/icon-tuvi.akinet.me-96.png'],
  ['Aki Dev', 'https://dev.akitao.com', '/pj/icon-dev.akitao.com-96.png'],
  ['AkiDevRule', RULES_REPO_URL, '/aki-dev-rule-icon.png'],
  ['Aki Dev Sync', 'https://github.com/lacvietanh/aki-dev-sync', '/pj/icon-aki-dev-sync-96.png'],
  ['AkiVN', 'https://akivn.net', '/pj/icon-akivn.net-96.png'],
  ['Aki Cloud', 'https://cloud.akivn.net', '/pj/icon-cloud.akivn.net-96.png'],
  ['AkiApp', 'https://app.akinet.me', '/pj/icon-app.akinet.me-96.png'],
  ['VSTShop.com', 'https://vstshop.com', '/pj/icon-vstshop.com-96.png'],
  ['AkiNet.me', 'https://akinet.me', '/pj/icon-akinet.me-96.png'],
  ['Aki Workflow', 'https://akiworkflow.com', '/pj/icon-akiworkflow.com-96.png'],
  ['LamNhac.net', 'https://lamnhac.net', '/pj/icon-lamnhac.net-96.png'],
  ['XKproduction.com', 'https://xkproduction.com', '/pj/icon-xkproduction.com-96.png'],
  ['Oscar Entertainment', 'https://oscarfamily.vn', '/pj/icon-oscarfamily.vn-96.png'],
  ['Oscar Music Group', 'https://oscarlabel.com', '/pj/icon-oscarlabel.com-96.png'],
  ['Oscar Studio', 'https://studio.oscarfamily.vn', '/pj/icon-studio.oscarfamily.vn-96.png'],
  ['DiSanHonViet.com', 'https://disanhonviet.com', '/pj/icon-disanhonviet.com-96.png'],
  ['DisanBudang.com', 'https://disanbudang.com', '/pj/icon-disanbudang.com-96.png'],
];

// akitao renders these as a Font Awesome webfont; inlining the four marks keeps the panel self-contained.
const SVG = {
  github: 'M12 .3a12 12 0 00-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.9 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 016 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0012 .3',
  linkedin: 'M20.4 20.5h-3.6V15c0-1.3 0-3-1.8-3s-2.1 1.4-2.1 2.9v5.6H9.4V9h3.4v1.6h.04c.5-.9 1.6-1.9 3.4-1.9 3.6 0 4.3 2.4 4.3 5.5v6.3zM5.3 7.4a2.1 2.1 0 110-4.1 2.1 2.1 0 010 4.1zm1.8 13.1H3.6V9h3.5v11.5zM22.2 0H1.8C.8 0 0 .8 0 1.7v20.6C0 23.2.8 24 1.8 24h20.4c1 0 1.8-.8 1.8-1.7V1.7C24 .8 23.2 0 22.2 0z',
  messenger: 'M12 2C6.5 2 2 6.1 2 11.2c0 2.9 1.4 5.5 3.6 7.2V22l3.3-1.8c1 .3 2 .4 3.1.4 5.5 0 10-4.1 10-9.4S17.5 2 12 2zm1 12.4l-2.5-2.7-5 2.7 5.5-5.8 2.6 2.7 4.9-2.7-5.5 5.8z',
  mail: 'M3 5h18a1 1 0 011 1v12a1 1 0 01-1 1H3a1 1 0 01-1-1V6a1 1 0 011-1zm.6 2L12 12.6 20.4 7H3.6z',
};
const SOCIAL = [
  ['GitHub', 'https://github.com/lacvietanh', SVG.github],
  ['LinkedIn', 'https://www.linkedin.com/in/lacvietanh', SVG.linkedin],
  ['Messenger', 'https://m.me/akinet?t=frommcpsv', SVG.messenger],
  ['Email', 'mailto:admin@akitao.com', SVG.mail],
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ecoLink = ([name, url, icon]) =>
  `<li><a class="eco-link" href="${esc(url)}" target="_blank" rel="noopener"><img class="eco-icon" src="${SITE}${icon}" alt="" width="20" height="20" loading="lazy"><span>${esc(name)}</span></a></li>`;

const socialLink = ([label, url, path]) =>
  `<a class="social" href="${esc(url)}" target="_blank" rel="noopener" aria-label="${esc(label)}" title="${esc(label)}"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg></a>`;

function field(label, value, mono = true) {
  return `<div class="row"><label>${esc(label)}</label><div class="val ${mono ? 'mono' : ''}" data-copy>${esc(value)}</div><button onclick="copyFrom(this)">copy</button></div>`;
}

export function renderPanel({ origin, client, passphrase, token, repoRoot, dataDir, rulesDir, userDir }) {
  const url = origin ? `${origin}/mcp` : 'chưa có — xem mục 1';
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(MCP_NAME)} — panel</title>
<link rel="icon" href="/favicon/favicon.ico" sizes="any"><meta name="theme-color" content="#ff4800">
<style>
:root { color-scheme: light dark; --bg:#faf9f7; --card:#fff; --line:#e5e2dc; --fg:#1a1a1a; --muted:#6b6b6b; --accent:#ff4800; --ok:#2e7d32; --err:#c62828; }
@media (prefers-color-scheme: dark) { :root { --bg:#1a1817; --card:#232120; --line:#38352f; --fg:#ececec; --muted:#9a948c; --ok:#7bc47f; --err:#ef9a9a; } }
* { box-sizing: border-box; }
body { font-family: -apple-system, system-ui, sans-serif; background: var(--bg); color: var(--fg); margin: 0; padding: 24px 16px 8px; font-size: 14px; }
main { max-width: 880px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; }
p.sub { color: var(--muted); margin: 0 0 20px; font-size: 13px; line-height: 1.6; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 14px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 12px; }
.hint { color: var(--muted); font-size: 12.5px; line-height: 1.7; margin: 0 0 10px; }
.row { display: grid; grid-template-columns: 130px 1fr auto; gap: 10px; align-items: center; margin-bottom: 8px; }
.row label { color: var(--muted); font-size: 13px; }
.val { padding: 8px 10px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; overflow-x: auto; white-space: nowrap; }
.mono, textarea, input[type=text], code { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
code { background: var(--bg); border: 1px solid var(--line); border-radius: 5px; padding: 1px 5px; }
button { border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 12px; }
button:hover { border-color: var(--accent); color: var(--accent); }
button.primary { border-color: var(--accent); background: var(--accent); color: #fff; }
button[disabled] { opacity: .55; cursor: progress; }
textarea, input[type=text] { width: 100%; padding: 9px 10px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; color: var(--fg); }
textarea { min-height: 90px; resize: vertical; line-height: 1.5; }
.lnk { font-size: 12px; margin: 0 0 10px; }
.acts { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
.checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(215px, 1fr)); gap: 4px 12px; margin-bottom: 12px; }
.checks label { display: flex; gap: 6px; align-items: center; font-size: 12px; font-family: ui-monospace, Menlo, monospace; }
.pathlist { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.pathlist div { display: flex; gap: 6px; }
.msg { font-size: 12px; margin-left: 4px; }
.msg.ok { color: var(--ok); } .msg.err { color: var(--err); }
a { color: var(--accent); }
.btnlink { border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; font-size: 12px; text-decoration: none; }
.btnlink:hover { border-color: var(--accent); }
.steps { margin: 0; padding-left: 18px; color: var(--muted); font-size: 12.5px; line-height: 1.9; }
.steps li { margin-bottom: 2px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 4px 16px; font-size: 12.5px; color: var(--muted); margin: 0 0 10px; }
.stats b { color: var(--accent); font-size: 14px; }
.warn { border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 8px; padding: 10px 12px; margin-top: 10px; }
.warn p { margin: 0; font-size: 12.5px; color: var(--muted); line-height: 1.7; }
.dot { display: inline-block; width: 15px; font-weight: 700; }
.dot.ok { color: var(--ok); } .dot.err { color: var(--err); }
.empty { color: var(--muted); font-size: 12.5px; font-family: inherit; }
figure { margin: 10px 0 0; }
figure img { width: 100%; max-width: 560px; border: 1px solid var(--line); border-radius: 10px; display: block; }
footer { border-top: 1px solid var(--line); margin-top: 24px; padding: 24px 0 28px; color: var(--muted); }
.foot-grid { display: grid; grid-template-columns: 1.1fr 2fr; gap: 28px; }
.foot-brand { display: flex; flex-direction: column; gap: 10px; }
.foot-logo { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; width: fit-content; font-size: 17px; font-weight: 800; color: var(--fg); }
.foot-logo img { border-radius: 7px; }
.foot-logo b { color: var(--accent); font-weight: 800; }
.foot-desc { font-size: 12.5px; line-height: 1.6; margin: 0; max-width: 260px; }
.foot-social { display: flex; flex-wrap: wrap; gap: 6px; }
.social { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--muted); transition: color .15s, border-color .15s; }
.social:hover { color: var(--accent); border-color: var(--accent); }
.social img { border-radius: 3px; opacity: .75; }
.social:hover img { opacity: 1; }
.foot-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; margin: 0 0 10px; }
.eco-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 4px; }
.eco-grid ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; }
.eco-link { display: flex; align-items: center; gap: 7px; text-decoration: none; padding: 4px 6px; border-radius: 7px; color: var(--muted); font-size: 12.5px; }
.eco-link:hover { background: var(--bg); color: var(--fg); }
.eco-icon { border-radius: 4px; object-fit: cover; flex-shrink: 0; background: #fff; padding: 1px; }
.foot-bottom { border-top: 1px solid var(--line); margin-top: 20px; padding-top: 14px; text-align: center; font-size: 11.5px; opacity: .7; }
@media (max-width: 700px) { .foot-grid { grid-template-columns: 1fr; } }
@media (max-width: 560px) { .row { grid-template-columns: 1fr; } .eco-grid { grid-template-columns: 1fr; } }
</style></head><body><main>
<h1>${esc(MCP_NAME)}</h1>
<p class="sub">Panel cục bộ (127.0.0.1) — không đi qua Funnel, không ra internet.<br>Repo đang chạy: <span class="mono">${esc(repoRoot)}</span> · Cấu hình &amp; khoá của bạn: <span class="mono">${esc(userDir)}</span></p>

<section><h2>1 · Tailscale — đường để claude.ai với tới máy này</h2>
<p class="hint">claude.ai cần một địa chỉ để gọi tới máy bạn. Làm 2 bước dưới đây, chỉ một lần.</p>
<ol class="steps">
  <li><span class="dot" id="tsInstalled">…</span> <a href="${TAILSCALE_DOWNLOAD_URL}" target="_blank" rel="noopener">Cài Tailscale</a> rồi đăng nhập.</li>
  <li><span class="dot" id="tsFunnel">…</span> Bật <a href="${TAILSCALE_FUNNEL_URL}" target="_blank" rel="noopener">Funnel</a> cho tailnet — miễn phí ở mọi gói. <code>npm start</code> tự bật giúp; chỉ khi tailnet chưa cho phép thì nó in ra link để bạn duyệt một lần.</li>
</ol>
<div class="acts"><button data-act="tailscale">Kiểm tra lại</button><span class="msg" id="msgTs"></span></div>
</section>

<section id="connector"><h2>2 · Connector — dán vào claude.ai</h2>
<p class="lnk"><a href="${CONNECTOR_URL}" target="_blank" rel="noopener">↗ Mở trang Add custom connector</a></p>
${field('MCP Name', MCP_NAME, false)}
${field('MCP URL', url)}
${field('OAuth Client ID', client.clientId)}
${field('OAuth Client Secret', client.clientSecret)}
${field('Passphrase', passphrase)}
<div class="acts"><button class="primary" data-act="copyAll">Copy cả 5 giá trị</button><span class="msg" id="msgConn"></span></div>
</section>

<section><h2>3 · Thư mục Claude được phép truy cập</h2>
<p class="hint">Ngoài danh sách này Claude bị từ chối hoàn toàn.</p>
<div class="pathlist" id="paths"></div>
<div class="acts">
  <button class="primary" data-act="pickFolder">+ Chọn thư mục…</button>
  <button data-act="savePaths">Lưu &amp; restart hub</button>
  <button data-act="restart">Restart hub</button>
  <span class="msg" id="msgPaths"></span>
</div>
</section>

<section><h2>4 · Lệnh shell được phép</h2>
<p class="hint">Bộ mặc định đang chạy, toàn lệnh chỉ-đọc. Xoá một dòng là gỡ quyền chạy lệnh đó. Thêm lệnh ghi (<code>rm</code>, <code>git commit</code>…) là bạn tự mở rộng quyền — cân nhắc.<br>
<code>null</code> = cho mọi subcommand · mảng = chỉ những subcommand trong mảng.</p>
<textarea id="allowlist" spellcheck="false" style="min-height:170px"></textarea>
<div class="acts"><button class="primary" data-act="saveAllowlist">Lưu allowlist</button><span class="msg" id="msgAllow"></span></div>
</section>

<section><h2>5 · akidevrule — luật làm việc cho AI (tuỳ chọn)</h2>
<p class="hint">Mỗi phiên mới, Claude đoán lại từ đầu: viết dài hay ngắn, được tự sửa tới đâu, đặt tên thế nào. <strong>akidevrule</strong> chốt sẵn những thứ đó thành file, nạp đúng lúc cần.</p>
<div class="stats">
  <span><b>17</b> file rule — code, docs, UI, DB, SEO, release, bảo mật</span>
  <span><b>9</b> skill — <code>/akithink</code>, <code>/akilint</code>, <code>/akiflow</code>, <code>/akigitcommit</code>…</span>
  <span><b>5</b> subagent chuyên trách — tìm, chấm, phản biện, thi công</span>
  <span>Một lần cài, dùng chung <b>5</b> CLI: Claude Code, Gemini, Codex, Kiro, Grok</span>
</div>
<p class="hint">Nút "Cài / cập nhật" chạy đúng lệnh dưới đây. Không sudo, chỉ ghi vào <span class="mono">~/.aki</span> và <span class="mono">~/.claude</span>, gỡ bằng <code>rm -rf</code>. Bỏ qua mục này mọi thứ còn lại vẫn chạy.</p>
${field('Lệnh cài', RULES_INSTALL_CMD)}
<div class="acts">
  <button class="primary" data-act="installRules">Cài / cập nhật</button>
  <a class="btnlink" href="${RULES_REPO_URL}" target="_blank" rel="noopener">Xem repo ↗</a>
  <span class="msg" id="msgRules"></span>
</div>
</section>

<section><h2>6 · Instructions — prompt dán vào claude.ai</h2>
<p class="hint">Dán đoạn dưới vào Settings → General → Personal preferences. Nó dạy Claude dùng đúng tool của server này, và nạp rule nếu bạn đã cài ở mục 5.</p>
<p class="lnk"><a href="${SETTINGS_URL}" target="_blank" rel="noopener">↗ Mở Settings → General</a></p>
<label style="display:flex;gap:6px;align-items:center;font-size:13px;margin-bottom:10px">
  <input type="checkbox" id="loadRules" checked> Bắt đọc rule đầu mỗi phiên
</label>
<div class="checks" id="ruleChecks"></div>
<textarea id="prompt" readonly style="min-height:130px"></textarea>
<div class="acts"><button class="primary" onclick="copyText(document.getElementById('prompt').value, this)">copy prompt</button></div>
</section>

<section><h2>7 · Tiện ích</h2>
<p class="hint"><strong>Claude Token Counter</strong> — extension Chrome hiện thanh hạn mức theo giờ và theo tuần ngay dưới ô nhập của claude.ai, <strong>kể cả tài khoản Free</strong>. claude.ai không hiển thị con số này ở đâu cả.</p>
<div class="acts"><a class="btnlink" href="${esc(TOKENIZER_URL)}" target="_blank" rel="noopener">Cài từ Chrome Web Store ↗</a></div>
<figure><img src="/claude-tokenizer-chrome-extension.png" alt="Thanh hạn mức token hiển thị dưới ô nhập của claude.ai" loading="lazy"></figure>
</section>

<section><h2>8 · Chrome — tuỳ chọn</h2>
<p class="hint">Kết nối xong, panel điều khiển được tab Chrome của bạn. Không cần mục này thì mọi thứ phía trên vẫn chạy.</p>
<div class="acts">
  <button class="primary" data-act="connect">Kết nối Chrome</button>
  <button data-act="tabs">Nạp danh sách tab</button>
  <button data-act="widen">Mở rộng khung chat claude.ai</button>
  <span class="msg" id="msgChrome"></span>
</div>
<div class="warn" id="chromeRestart" hidden>
  <p>Chrome đang mở nhưng chưa bật cổng debug, mà Chrome chỉ bật được cổng này lúc khởi động. Mở lại là cách duy nhất — Chrome sẽ thoát êm và khôi phục lại đúng các tab đang mở.</p>
  <div class="acts"><button data-act="restartChrome">Mở lại Chrome</button></div>
</div>
<div class="checks" id="tabs" style="margin-top:10px"></div>
<p class="hint" style="margin:14px 0 0">Không muốn kết nối Chrome thì dán thẳng lệnh dưới vào Console của tab claude.ai (<code>Cmd ⌥ J</code>) — kết quả y hệt nút "Mở rộng khung chat".</p>
${field('Lệnh mở rộng', WIDEN_SNIPPET)}
</section>

<footer>
  <div class="foot-grid">
    <div class="foot-brand">
      <a class="foot-logo" href="${SITE}" target="_blank" rel="noopener"><img src="${SITE}/favicon/icon-192.png" alt="" width="32" height="32">Aki<b>Tao</b></a>
      <p class="foot-desc">Công nghệ phát triển, bản sắc thương hiệu không đổi.</p>
      <div class="foot-social">${SOCIAL.map(socialLink).join('')}<a class="social" href="https://zalo.me/0869297957" target="_blank" rel="noopener" aria-label="Zalo" title="Zalo"><img src="${SITE}/img/icon-zalo.png" alt="" width="15" height="15" loading="lazy"></a></div>
    </div>
    <div>
      <p class="foot-title">Hệ sinh thái</p>
      <div class="eco-grid">
        <ul>${ECOSYSTEM.slice(0, 11).map(ecoLink).join('')}</ul>
        <ul>${ECOSYSTEM.slice(11).map(ecoLink).join('')}</ul>
      </div>
    </div>
  </div>
  <p class="foot-bottom">© 2020–<span id="year"></span> AkiTao. All rights reserved.</p>
</footer>
</main>
<script>
const TOKEN = ${JSON.stringify(token)};
const RULES_DIR = ${JSON.stringify(rulesDir)};
const CLAUDE_DIR = ${JSON.stringify(CLAUDE_DIR)};
const REPO_ROOT = ${JSON.stringify(repoRoot)};
const DATA_DIR = ${JSON.stringify(dataDir)};
const MCP_NAME = ${JSON.stringify(MCP_NAME)};
const DEFAULT_RULES = ${JSON.stringify(DEFAULT_RULES)};
const WIDEN = ${JSON.stringify(WIDEN_SNIPPET)};

document.getElementById('year').textContent = new Date().getFullYear();

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-panel-token': TOKEN },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // A dead panel process is the single most likely failure here, and the browser's own wording for it says nothing a user can act on.
    throw new Error('không gọi được panel — kiểm tra "npm start" còn chạy không');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'lỗi không rõ');
  return data;
}

function say(id, text, ok = true) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}

async function act(btn, id, fn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'đang chạy…';
  try { say(id, await fn(), true); } catch (e) { say(id, e.message, false); }
  btn.disabled = false; btn.textContent = old;
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.textContent; btn.textContent = 'copied'; setTimeout(() => (btn.textContent = old), 1200);
  });
}
function copyFrom(btn) { copyText(btn.closest('.row').querySelector('[data-copy]').textContent, btn); }

function buildPrompt() {
  const lines = ['LUÔN TRẢ LỜI NGẮN GỌN, CÔ ĐỌNG, ĐÚNG TRỌNG TÂM. KHÔNG BỊA, KHÔNG SUY DIỄN. Khẳng định phải có căn cứ, tìm kiếm phải có chứng cứ.'];
  const picked = document.getElementById('loadRules').checked
    ? [...document.querySelectorAll('#ruleChecks input:checked')].map((i) => i.value)
    : [];
  if (picked.length) {
    lines.push('Đầu mỗi phiên có MCP "' + MCP_NAME + '", trước khi trả lời: dùng filesystem tool đọc ' + CLAUDE_DIR + '/CLAUDE.md và các file rule ' + picked.map((f) => RULES_DIR + '/' + f).join(', ') + ', rồi tuân theo cho toàn bộ hội thoại. Router đầy đủ: ' + CLAUDE_DIR + '/skills/akirule/SKILL.md.');
  }
  lines.push('Tìm file/thư mục: LUÔN dùng tool find_path (quét cả cây trong 1 lần gọi, ra cả thư mục, ~0.2s). Đừng list_directory từng cấp, đừng dùng search_files của filesystem — nó không trả thư mục và hay timeout. Tìm nội dung trong file thì dùng search_content.');
  lines.push('Muốn chạy git/ls/grep trong một thư mục cụ thể: gọi tool run_cmd kèm tham số cwd (đường dẫn tuyệt đối, nằm dưới ' + DATA_DIR + '), đừng dùng cd hay -C.');
  lines.push('Repo của chính MCP server này: ' + REPO_ROOT + ' — cần sửa nó thì vào thẳng đường dẫn đó, đừng đi tìm.');
  document.getElementById('prompt').value = lines.join('\\n');
}

// Nothing about a folder row says whether it is live or merely typed, so the Save button carries the mark instead.
function markDirty() {
  document.querySelector('[data-act="savePaths"]').classList.add('primary');
  say('msgPaths', 'có thay đổi chưa lưu', false);
}

function addPath(value, dirty) {
  const wrap = document.createElement('div');
  const input = document.createElement('input');
  input.type = 'text'; input.value = value;
  input.oninput = markDirty;
  const del = document.createElement('button');
  del.textContent = '×';
  del.onclick = () => { wrap.remove(); markDirty(); };
  wrap.append(input, del);
  document.getElementById('paths').append(wrap);
  if (dirty) markDirty();
}

function renderTabs(tabs) {
  const box = document.getElementById('tabs');
  box.innerHTML = tabs.length ? '' : '<span class="empty">Chrome không có tab nào đang mở.</span>';
  for (const t of tabs) {
    const label = document.createElement('label');
    label.innerHTML = '<input type="radio" name="tab" value="' + t.id + '">';
    label.title = t.url;
    label.append(document.createTextNode(t.title.slice(0, 40) || t.url.slice(0, 40)));
    box.append(label);
  }
  return tabs.length;
}

// Loading the tab list right after connecting is the proof the connection worked — a success message with an empty box underneath reads as nothing having happened.
async function showTabs() {
  const { tabs } = await api('GET', '/api/chrome/tabs');
  return renderTabs(tabs) + ' tab';
}

function renderRuleChecks(files) {
  const checks = document.getElementById('ruleChecks');
  checks.innerHTML = '';
  if (!files.length) {
    checks.innerHTML = '<span class="empty">Chưa cài akidevrule — cài ở mục 5 phía trên, hoặc bỏ qua và dùng prompt không có rule.</span>';
    return;
  }
  for (const f of files) {
    const label = document.createElement('label');
    label.innerHTML = '<input type="checkbox" value="' + f + '"' + (DEFAULT_RULES.includes(f) ? ' checked' : '') + '>';
    label.append(document.createTextNode(f.replace(/^(RULE|METHOD)-/, '').replace(/\\.md$/, '')));
    checks.append(label);
  }
}

async function loadState() {
  const s = await api('GET', '/api/state');
  document.getElementById('allowlist').value = JSON.stringify(s.allowlist, null, 2);
  s.paths.forEach((p) => addPath(p));
  renderRuleChecks(s.ruleFiles);
  document.getElementById('ruleChecks').onchange = buildPrompt;
  document.getElementById('loadRules').onchange = buildPrompt;
  buildPrompt();
}

async function loadTailscale() {
  const mark = (id, ok) => {
    const el = document.getElementById(id);
    el.textContent = ok ? '✓' : '✕';
    el.className = 'dot ' + (ok ? 'ok' : 'err');
  };
  const s = await api('GET', '/api/tailscale');
  mark('tsInstalled', s.installed);
  mark('tsFunnel', s.funnel);
  if (!s.installed) return 'chưa thấy lệnh tailscale trên máy';
  if (!s.funnel) return 'đã cài Tailscale, còn thiếu Funnel cho cổng 9999';
  return 'sẵn sàng: ' + (s.host || 'chưa lấy được tên miền');
}

async function pickTab(match) {
  let picked = document.querySelector('#tabs input:checked')?.value;
  if (picked) return picked;
  const { tabs } = await api('GET', '/api/chrome/tabs');
  renderTabs(tabs);
  picked = tabs.find(match)?.id;
  if (!picked) throw new Error('không thấy tab claude.ai — mở một tab claude.ai rồi bấm lại');
  return picked;
}

const ACTIONS = {
  tailscale: (btn) => act(btn, 'msgTs', loadTailscale),
  copyAll: (btn) => act(btn, 'msgConn', async () => {
    // Scoped to this section: every copyable command elsewhere on the page is a .row too.
    const rows = [...document.querySelectorAll('#connector .row')].map((r) => r.querySelector('label').textContent + ': ' + r.querySelector('[data-copy]').textContent);
    await navigator.clipboard.writeText(rows.join('\\n'));
    return 'đã copy ' + rows.length + ' giá trị';
  }),
  pickFolder: (btn) => act(btn, 'msgPaths', async () => {
    const { folders } = await api('POST', '/api/pick-folder');
    if (!folders.length) return 'chưa chọn thư mục nào';
    const existing = new Set([...document.querySelectorAll('#paths input')].map((i) => i.value));
    const added = folders.filter((f) => !existing.has(f));
    added.forEach((f) => addPath(f, true));
    return added.length ? 'đã thêm ' + added.length + ' thư mục — bấm Lưu để áp dụng' : 'thư mục đã có trong danh sách';
  }),
  savePaths: (btn) => act(btn, 'msgPaths', async () => {
    const paths = [...document.querySelectorAll('#paths input')].map((i) => i.value.trim()).filter(Boolean);
    if (!paths.length) throw new Error('danh sách trống sẽ cắt hết quyền đọc file của Claude — thêm ít nhất một thư mục');
    const { message } = await api('POST', '/api/paths', { paths });
    btn.classList.remove('primary');
    return message;
  }),
  restart: (btn) => act(btn, 'msgPaths', async () => (await api('POST', '/api/restart')).message),
  saveAllowlist: (btn) => act(btn, 'msgAllow', async () => {
    let allowlist;
    try {
      allowlist = JSON.parse(document.getElementById('allowlist').value || '{}');
    } catch {
      throw new Error('JSON chưa hợp lệ — thường là thiếu dấu phẩy hoặc thừa dấu phẩy ở dòng cuối');
    }
    return (await api('POST', '/api/allowlist', { allowlist })).message;
  }),
  installRules: (btn) => act(btn, 'msgRules', async () => {
    const { message } = await api('POST', '/api/install-rules');
    renderRuleChecks((await api('GET', '/api/state')).ruleFiles);
    buildPrompt();
    return message;
  }),
  connect: (btn) => act(btn, 'msgChrome', async () => {
    const { state, message } = await api('POST', '/api/chrome/connect');
    document.getElementById('chromeRestart').hidden = state !== 'needsRestart';
    return state === 'ready' ? message + ' — ' + (await showTabs()) : message;
  }),
  restartChrome: (btn) => act(btn, 'msgChrome', async () => {
    const { message } = await api('POST', '/api/chrome/restart');
    document.getElementById('chromeRestart').hidden = true;
    return message + ' — ' + (await showTabs());
  }),
  tabs: (btn) => act(btn, 'msgChrome', showTabs),
  widen: (btn) => act(btn, 'msgChrome', async () => {
    await api('POST', '/api/chrome/eval', { tabId: await pickTab((t) => t.url.includes('claude.ai')), js: WIDEN });
    return 'đã mở rộng khung chat';
  }),
};

document.querySelectorAll('[data-act]').forEach((btn) => (btn.onclick = () => ACTIONS[btn.dataset.act](btn)));

// One failed /api/state leaves three sections blank, so the failure is reported next to each of them.
loadState().catch((e) => ['msgPaths', 'msgAllow', 'msgRules'].forEach((id) => say(id, e.message, false)));
loadTailscale().then((m) => say('msgTs', m, m.startsWith('sẵn sàng'))).catch((e) => say('msgTs', e.message, false));
</script>
</body></html>`;
}

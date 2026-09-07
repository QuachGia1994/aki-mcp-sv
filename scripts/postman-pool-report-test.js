#!/usr/bin/env node
// Outbound-only Postman pool report smoke test: sends exactly one Bot API sendMessage.
// It never reads inbound updates and never alters the bot routing configuration.
import { resolveReportCredentials, sendPostmanPoolReportMessage, POSTMAN_POOL_CONFIG_PATH } from './postman-pool.js';

function redact(value) {
  return String(value || '')
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    .replace(/https:\/\/\S+/g, '<url>');
}

function parseArgs(argv) {
  const parsed = { configPath: undefined, text: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') {
      parsed.configPath = argv[i + 1];
      i += 1;
    } else {
      parsed.text.push(argv[i]);
    }
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.configPath || POSTMAN_POOL_CONFIG_PATH;
  const creds = resolveReportCredentials(configPath);
  if (!creds.reportBotToken || !creds.reportChatId) {
    console.error(`missing report config: reportBotToken=${creds.reportBotToken ? 'set' : 'MISSING'} reportChatId=${creds.reportChatId || 'MISSING'} (token source: ${creds.tokenSource})`);
    return 2;
  }
  const text = args.text.length ? args.text.join(' ') : 'Aki Postman pool: outbound test message (sendMessage only). Inbound routing was not touched.';
  try {
    const result = await sendPostmanPoolReportMessage(creds, text);
    console.log(`sent test report via sendMessage to chat ${creds.reportChatId} (token source: ${creds.tokenSource}); message_id=${result?.message_id ?? 'n/a'}`);
    return 0;
  } catch (error) {
    console.error(`test report failed: ${redact(error?.message)}`);
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(redact(error?.message));
    process.exit(1);
  });

#!/usr/bin/env node
// Allowlist-gated shell MCP, in-house (npm `shell-mcp` has no real whitelist) — rationale: docs/plan/init.md
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { loadAllowlist } from './allowlist.js';
import { ROOT, ROOTS, resolveUnderRoot } from './roots.js';

class Shell {
  // Backslash is escape/chaining on Unix but the normal path separator on Windows — only treat it as dangerous off-Windows.
  static DANGEROUS_CHARS = process.platform === 'win32' ? /[;&|`$<>\n]/ : /[;&|`$<>\n\\]/;

  // Quotes group an argument and are then stripped, as a shell would. Splitting on whitespace alone left them in the argv, so `find -name "*.ts"` silently searched for a name containing quote marks.
  static tokenize(command) {
    const tokens = [];
    let current = '';
    let started = false;
    let quote = null;
    for (const char of command.trim()) {
      if (quote) {
        if (char === quote) quote = null;
        else current += char;
      } else if (char === '"' || char === "'") {
        quote = char;
        started = true;
      } else if (/\s/.test(char)) {
        if (started) tokens.push(current);
        current = '';
        started = false;
      } else {
        current += char;
        started = true;
      }
    }
    if (quote) throw new Error('unterminated quote');
    if (started) tokens.push(current);
    return tokens;
  }

  parse(command) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('empty command');
    }
    if (Shell.DANGEROUS_CHARS.test(command)) {
      throw new Error('command chaining/redirection is not allowed');
    }
    const [bin, ...args] = Shell.tokenize(command);
    if (!bin) throw new Error('empty command');
    return { bin, args };
  }

  checkPermission(bin, args) {
    const allowlist = loadAllowlist();
    if (!(bin in allowlist)) {
      throw new Error(`"${bin}" is not in the allowlist`);
    }
    const allowedSubcommands = allowlist[bin];
    if (Array.isArray(allowedSubcommands) && !allowedSubcommands.includes(args[0])) {
      throw new Error(`"${bin} ${args[0] ?? ''}" is not in the allowlist`);
    }
  }

  run(bin, args, cwd) {
    return new Promise((resolve) => {
      execFile(bin, args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          resolve({ content: [{ type: 'text', text: stderr || err.message }], isError: true });
        } else {
          resolve({ content: [{ type: 'text', text: stdout || '(no output)' }] });
        }
      });
    });
  }

  async execute(command, cwd) {
    let bin, args, dir;
    try {
      ({ bin, args } = this.parse(command));
      this.checkPermission(bin, args);
      dir = resolveUnderRoot(cwd);
    } catch (e) {
      return { content: [{ type: 'text', text: `rejected: ${e.message}` }], isError: true };
    }
    return this.run(bin, args, dir);
  }
}

const shell = new Shell();

const server = new McpServer({ name: 'shell', version: '1.0.0' });

server.registerTool(
  'run_cmd',
  {
    description: `Run one shell command from the allowlist. Ships a read-only default set (ls, cat, grep, find, head, tail, stat, git status/log/diff/show, …), extendable in the local control panel. Pass cwd (absolute path under one of ${ROOTS.join(', ')}, or relative to ${ROOT}) to run inside a specific project directory — this is how you target a repo. No chaining, no redirection — one command per call.`,
    inputSchema: { command: z.string(), cwd: z.string().optional() },
  },
  ({ command, cwd }) => shell.execute(command, cwd),
);

await server.connect(new StdioServerTransport());

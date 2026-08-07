#!/usr/bin/env node
// Allowlist-gated shell MCP, in-house (npm `shell-mcp` has no real whitelist) — rationale: docs/plan/init.md
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// null = any subcommand allowed; array = only those subcommands. Curated to read-only binaries.
const DEFAULT_ALLOWLIST = {
  ls: null, cat: null, pwd: null, find: null, grep: null, head: null, tail: null,
  wc: null, file: null, stat: null, tree: null, ps: null, df: null, du: null,
  whoami: null, uname: null,
  git: ['status', 'log', 'diff', 'show'],
};

const SETTINGS_PATH = path.join(os.homedir(), '.aki', 'mcpsv', 'setting.json');

// Shell reach = the project volume only (MCP_DATA_DIR); the filesystem MCP adds read paths (~/.aki, ~/.claude/skills) that shell deliberately does not get.
const ROOT = path.resolve(process.env.MCP_DATA_DIR || '/Volumes/DEV');

function resolveCwd(cwd) {
  if (!cwd) return ROOT;
  const abs = path.resolve(ROOT, cwd);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw new Error(`cwd is outside the allowed root ${ROOT}`);
  }
  return abs;
}

// Absent settings file is silent (defaults work out of the box); only a malformed one warns.
function loadAllowlist() {
  let raw;
  try {
    raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
  } catch {
    return DEFAULT_ALLOWLIST;
  }
  try {
    const user = JSON.parse(raw)?.shell?.allowlist;
    return user ? { ...DEFAULT_ALLOWLIST, ...user } : DEFAULT_ALLOWLIST;
  } catch (e) {
    process.stderr.write(`[shell] ignoring malformed ${SETTINGS_PATH}: ${e.message}\n`);
    return DEFAULT_ALLOWLIST;
  }
}

class Shell {
  static DANGEROUS_CHARS = /[;&|`$<>\n\\]/;

  parse(command) {
    if (typeof command !== 'string' || command.trim() === '') {
      throw new Error('empty command');
    }
    if (Shell.DANGEROUS_CHARS.test(command)) {
      throw new Error('command chaining/redirection is not allowed');
    }
    const [bin, ...args] = command.trim().split(/\s+/);
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
      execFile(bin, args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
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
      dir = resolveCwd(cwd);
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
    description: 'Run one shell command from the allowlist. Ships a read-only default set (ls, cat, grep, find, head, tail, stat, git status/log/diff/show, …), extendable per-machine via ~/.aki/mcpsv/setting.json → shell.allowlist. Pass cwd (absolute or relative to the filesystem root) to run inside any project directory under that root — this is how you target a specific repo. No chaining, no redirection — one command per call.',
    inputSchema: { command: z.string(), cwd: z.string().optional() },
  },
  ({ command, cwd }) => shell.execute(command, cwd),
);

await server.connect(new StdioServerTransport());

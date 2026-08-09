#!/usr/bin/env node
// Dedicated MCP for the `kiro-cli` "arm": passes the prompt as a separate execFile arg so no shell-tokenizing step can mis-split a multi-word prompt (same reason agy-mcp.js exists). Read and write are two separate tools so the connector's per-tool approval UI can grant write independently of read.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { resolveUnderRoot } from './roots.js';
import { ok, err, fail } from './mcp-tool.js';

// Owner requirement ("khóa cứng"): the model is not a tool parameter, so a prompt cannot escalate to a pricier or different tier.
// Verified 2026-08-09 against `kiro-cli chat --list-models` (kiro-cli 2.16.2): claude-sonnet-4.5 is a real id (1.30x credits). See docs/ref/harness-fact.md § Kiro.
const MODEL = 'claude-sonnet-4.5';

function run(trustTools, { prompt, effort, cwd }) {
  let dir;
  try {
    dir = resolveUnderRoot(cwd);
  } catch (e) {
    return Promise.resolve(fail(e));
  }
  const args = ['chat', '--no-interactive', '--model', MODEL, `--trust-tools=${trustTools}`];
  if (effort) args.push('--effort', effort);
  args.push(prompt);
  return new Promise((resolve) => {
    execFile('kiro-cli', args, { cwd: dir, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        return resolve(err(stdout || stderr || error.message));
      }
      if (!stdout || !stdout.trim()) {
        return resolve(err('kiro-cli returned no output — the call may have been silently denied rather than a clean empty result. Re-check the prompt/scope.'));
      }
      resolve(ok(stdout));
    });
  });
}

const server = new McpServer({ name: 'kiro', version: '1.0.0', title: 'Kiro CLI' });

const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('kiro-cli --effort, thinking budget');

server.registerTool(
  'kiro_read',
  {
    title: 'Kiro CLI (read-only)',
    description:
      `Delegate a read-only task to a Kiro CLI session locked to ${MODEL}. ` +
      'Restricted to fs_read by mechanism (--trust-tools=fs_read) — it can read files under the allowed roots but cannot write or run shell. ' +
      'prompt is passed straight to kiro-cli as one argument — no shell quoting, spaces/punctuation are safe as-is.',
    inputSchema: {
      prompt: z.string(),
      effort: effortSchema,
      cwd: z.string().optional().describe('run inside this project dir; must be under an allowed root'),
    },
  },
  async ({ prompt, effort, cwd }) => run('fs_read', { prompt, effort, cwd }),
);

server.registerTool(
  'kiro_write',
  {
    title: 'Kiro CLI (write)',
    description:
      `Delegate a task that may modify files to a Kiro CLI session locked to ${MODEL}. ` +
      'Grants fs_read and fs_write (--trust-tools=fs_read,fs_write) — it can create and edit files under the allowed roots, but nothing else (no shell/exec). ' +
      'Approve this tool deliberately: it can change files on disk. prompt is passed straight to kiro-cli as one argument — no shell quoting needed.',
    inputSchema: {
      prompt: z.string(),
      effort: effortSchema,
      cwd: z.string().optional().describe('run inside this project dir; must be under an allowed root'),
    },
  },
  async ({ prompt, effort, cwd }) => run('fs_read,fs_write', { prompt, effort, cwd }),
);

await server.connect(new StdioServerTransport());

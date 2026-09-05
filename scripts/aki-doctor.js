import { existsSync, readdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { USER_DIR } from './userdata.js';
import { getRoots, overlaps } from './roots.js';
import { loadAllowlistDirs, readSettings } from './allowlist.js';
import { getLocalVersions } from './update-check.js';
import { readXKiroConfig, getXKiroUsage } from './xkiro-mcp.js';
import { readOpenCodeConfig, getOpenCodeStatus, resolveOpenCodeExecutable } from './opencode-mcp.js';
import { resolveAgyExecutable } from './agy-mcp.js';
import { resolveKiroExecutable } from './kiro-mcp.js';
import { getContextOptimizerStatus } from './context-optimizer.js';
import { getBudgetRouterStatus, readCostLedger } from './budget-router.js';
import { getProjectGraphStatus } from './project-graph.js';
import { getTaskCheckpointStatus } from './task-checkpoint.js';
import { ok } from './mcp-tool.js';

const RULES_DIR = path.join(os.homedir(), '.aki', 'akidevrule');
const STATUS_ORDER = { PASS: 0, WARN: 1, FAIL: 2 };

function worst(...statuses) {
  return statuses.filter(Boolean).sort((a, b) => STATUS_ORDER[b] - STATUS_ORDER[a])[0] || 'PASS';
}

function executableState(executable) {
  if (!path.isAbsolute(executable)) return { status: 'WARN', executable, reason: 'resolved through PATH; presence not statically proven' };
  return existsSync(executable) ? { status: 'PASS', executable } : { status: 'FAIL', executable, reason: 'executable missing' };
}

function canConnect(port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function diagnoseMcpTransport() {
  const [loopbackMcp, panel] = await Promise.all([canConnect(Number(process.env.AKI_LOCAL_MCP_PORT || 19999)), canConnect(Number(process.env.AKI_PANEL_PORT || 9998))]);
  const oauthFiles = ['oauth-client.json', 'passphrase.txt'].map((name) => ({ name, exists: existsSync(path.join(USER_DIR, name)) }));
  const oauth = oauthFiles.every((entry) => entry.exists);
  return { status: worst(loopbackMcp ? 'PASS' : 'WARN', panel ? 'PASS' : 'WARN', oauth ? 'PASS' : 'WARN'), loopbackMcp, panel, oauth, oauthFiles };
}

export function diagnoseRootsAndSecurity() {
  const roots = getRoots();
  const trustedDirs = loadAllowlistDirs().map((dir) => ({ dir, conflicts: roots.filter((root) => overlaps(dir, root)) }));
  const conflicts = trustedDirs.filter((entry) => entry.conflicts.length);
  const ruleFiles = existsSync(RULES_DIR) ? readdirSync(RULES_DIR).filter((name) => /^(index|RULE-|METHOD-).+\.md$/.test(name) || name === 'index.md') : [];
  return {
    status: worst(roots.length ? 'PASS' : 'FAIL', conflicts.length ? 'WARN' : 'PASS', ruleFiles.length ? 'PASS' : 'WARN'),
    allowedRoots: roots,
    shellAllowAll: readSettings().shell?.allowAll === true,
    trustedDirs,
    trustedWritableConflicts: conflicts,
    rules: { path: RULES_DIR, files: ruleFiles.length, installed: ruleFiles.length > 0 },
    versions: getLocalVersions(),
  };
}

export async function diagnoseWorkers({ deep = false } = {}) {
  const agy = executableState(resolveAgyExecutable());
  const kiro = executableState(resolveKiroExecutable());
  const openCodeExecutable = executableState(resolveOpenCodeExecutable());
  const xConfig = readXKiroConfig();
  const oConfig = readOpenCodeConfig();
  let xkiro = { status: xConfig.configured ? 'PASS' : 'WARN', configured: xConfig.configured, model: xConfig.model };
  let opencode = { status: openCodeExecutable.status === 'FAIL' ? 'FAIL' : 'WARN', configured: null, selectedModel: oConfig.model, execEnabled: oConfig.execEnabled, executable: openCodeExecutable };
  if (deep) {
    const [xStatus, oStatus] = await Promise.all([getXKiroUsage().catch((error) => ({ error: error.message })), getOpenCodeStatus({ refresh: true }).catch((error) => ({ error: error.message }))]);
    xkiro = { ...xStatus, status: xStatus.configured && !xStatus.error ? 'PASS' : 'WARN' };
    opencode = { ...oStatus, executable: openCodeExecutable, status: oStatus.configured && !oStatus.error && openCodeExecutable.status !== 'FAIL' ? 'PASS' : openCodeExecutable.status === 'FAIL' ? 'FAIL' : 'WARN' };
  }
  return { status: worst(xkiro.status, opencode.status, agy.status, kiro.status), xkiro, opencode, agy, kiro };
}

export async function diagnoseSubsystems({ deep = false } = {}) {
  const contextOptimizer = getContextOptimizerStatus();
  const budgetRouter = deep ? await getBudgetRouterStatus({ refresh: true }) : { totals: readCostLedger().totals };
  const projectGraph = getProjectGraphStatus();
  const taskCheckpoint = getTaskCheckpointStatus();
  return { status: contextOptimizer.enabled ? 'PASS' : 'WARN', contextOptimizer, budgetRouter, projectGraph, taskCheckpoint };
}

export async function runAkiDoctor({ deep = false } = {}) {
  const [transport, workers, subsystems] = await Promise.all([diagnoseMcpTransport(), diagnoseWorkers({ deep }), diagnoseSubsystems({ deep })]);
  const security = diagnoseRootsAndSecurity();
  return { at: Date.now(), deep, status: worst(transport.status, security.status, workers.status, subsystems.status), transport, security, workers, subsystems };
}

function mark(status) {
  return status === 'PASS' ? '✓' : status === 'WARN' ? '!' : '✕';
}

export function renderDoctorMarkdown(report) {
  const lines = [`Aki Doctor ${report.status} · ${new Date(report.at).toISOString()}`, `${mark(report.transport.status)} MCP transport: ${report.transport.status} · loopback=${report.transport.loopbackMcp ? 'up' : 'down'} panel=${report.transport.panel ? 'up' : 'down'} oauth=${report.transport.oauth ? 'ready' : 'incomplete'}`, `${mark(report.security.status)} Roots/rules: ${report.security.status} · roots=${report.security.allowedRoots.length} rules=${report.security.rules.files} trusted-conflicts=${report.security.trustedWritableConflicts.length}`, `${mark(report.workers.status)} Workers: ${report.workers.status} · xKiro=${report.workers.xkiro.status} OpenCode=${report.workers.opencode.status} AGY=${report.workers.agy.status} Kiro=${report.workers.kiro.status}`, `${mark(report.subsystems.status)} Free-first subsystems: ${report.subsystems.status} · context=${report.subsystems.contextOptimizer.enabled ? 'on' : 'off'} graph-projects=${report.subsystems.projectGraph.projectCount} checkpoints=${report.subsystems.taskCheckpoint.entries}`];
  if (!report.deep) lines.push('Run with deep=true to refresh live xKiro/OpenCode status; Doctor never repairs or mutates configuration.');
  return lines.join('\n');
}

export function register(server) {
  server.registerTool('aki_doctor', { title: 'Aki Doctor', description: 'Read-only unified health report for local MCP transport, roots/rules, worker availability, Context Optimizer, Budget Router/ledger, Project Graph and task checkpoints. deep=true refreshes live xKiro/OpenCode status; Doctor never repairs anything.', inputSchema: { deep: z.boolean().optional().default(false) } }, async ({ deep }) => { const report = await runAkiDoctor({ deep }); return ok(`${renderDoctorMarkdown(report)}\n\n${JSON.stringify(report, null, 2)}`); });
}

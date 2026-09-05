// Allowlist-gated shell MCP tool, in-house (npm `shell-mcp` has no real whitelist) — rationale: docs/plan/done/init.md
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadAllowlist, loadAllowlistDirs, readSettings } from './allowlist.js';
import { getRoots, resolveRealUnderRootSync, containedIn, overlaps } from './roots.js';
import { ok, err, fail } from './mcp-tool.js';

// Interpreters run a script file passed as an argument, so trust must follow the script's path, not the interpreter binary (which lives on PATH, outside the trusted zones). Shells (sh/bash/zsh) are excluded on purpose — their argument is arbitrary code, not a file to locate under a zone.
const INTERPRETERS = new Set(['node', 'python', 'python3', 'bun', 'deno', 'tsx', 'ruby', 'perl', 'php']);

// ls-remote requires zero extra args — a repository/URL argument lets git's own ext:: transport helper spawn an arbitrary process before anything "read-only" happens; bare invocation only queries the configured remote.
const GIT_NO_ARGS_SUBCOMMANDS = new Set(['ls-remote']);
const GIT_SAFE_BRANCH_ARGS = new Set(['--list', '--show-current', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--no-color', '--column', '--no-column']);
const GIT_SAFE_REMOTE_ARGS = new Set(['-v', '--verbose']);
const GIT_SAFE_TAG_ARGS = new Set(['-l', '--list', '-n', '--column', '--no-column']);
const GIT_BLOCKED_READ_FLAGS = ['--output', '--ext-diff', '--textconv'];
const NODE_CMD_SHIMS = new Map([
  ['npm', 'npm-cli.js'],
  ['npm.cmd', 'npm-cli.js'],
  ['npx', 'npx-cli.js'],
  ['npx.cmd', 'npx-cli.js'],
]);

export function resolveExecFileTarget(bin, args, { platform = process.platform, execPath = process.execPath, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return { file: bin, args };
  const shim = NODE_CMD_SHIMS.get(path.basename(bin).toLowerCase());
  if (!shim) return { file: bin, args };
  const script = path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', shim);
  return exists(script) ? { file: execPath, args: [script, ...args] } : { file: bin, args };
}

const warnedDirs = new Set();
// The native filesystem tools read the same roots live as shell/search, so one root set is now the complete write surface. A trusted dir overlapping it would make write_file + run_cmd arbitrary code execution without allowlist review.
function activeTrustedDirs() {
  const writeRoots = getRoots();
  return loadAllowlistDirs().filter((dir) => {
    const clash = writeRoots.find((root) => overlaps(dir, root));
    if (clash && !warnedDirs.has(dir)) {
      warnedDirs.add(dir);
      process.stderr.write(`[shell] trusted dir ignored — overlaps writable root ${clash} (write+exec = RCE): ${dir}\n`);
    }
    return !clash;
  });
}

// realpath first so a symlink pointing out of a zone can't masquerade as being inside it; a non-existent path can't be a trusted script, so a throw here is a correct "no".
function underTrusted(p, dirs) {
  try {
    const abs = fs.realpathSync(path.resolve(p));
    return dirs.some((dir) => containedIn(abs, dir));
  } catch {
    return false;
  }
}

export function trustedInterpreterScriptArg(bin, args) {
  if (!INTERPRETERS.has(path.basename(bin))) return null;
  const script = args[0];
  return script && !script.startsWith('-') ? script : null;
}

function preallowedByDir(bin, args) {
  const dirs = activeTrustedDirs();
  if (!dirs.length) return false;
  if (bin.includes('/') || bin.includes('\\')) {
    if (!underTrusted(bin, dirs)) return false;
    try {
      fs.accessSync(fs.realpathSync(path.resolve(bin)), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const script = trustedInterpreterScriptArg(bin, args);
  return script ? underTrusted(script, dirs) : false;
}

function gitFlagAllowed(flag, safeSet, prefixes = []) {
  return safeSet.has(flag) || prefixes.some((prefix) => flag.startsWith(prefix));
}

function validateGitReadOnlyArgs(args) {
  const [subcommand, ...rest] = args;
  if (GIT_NO_ARGS_SUBCOMMANDS.has(subcommand) && rest.length) throw new Error(`"git ${subcommand}" only allowed with no further arguments`);
  if (rest.some((arg) => GIT_BLOCKED_READ_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) throw new Error('git option can execute helpers or write output and is blocked by the read-only policy');
  if (subcommand === 'branch' && rest.some((arg) => !gitFlagAllowed(arg, GIT_SAFE_BRANCH_ARGS, ['--sort=', '--format=', '--contains=', '--no-contains=', '--merged=', '--no-merged=', '--points-at=', '--color=']))) throw new Error('git branch is restricted to listing/query flags in read-only mode');
  if (subcommand === 'remote' && rest.some((arg) => !GIT_SAFE_REMOTE_ARGS.has(arg))) throw new Error('git remote is restricted to listing flags in read-only mode');
  if (subcommand === 'tag' && rest.some((arg) => !gitFlagAllowed(arg, GIT_SAFE_TAG_ARGS, ['--sort=', '--format=', '--points-at=', '--contains=', '--no-contains=', '--merged=', '--no-merged=', '--color=']))) throw new Error('git tag is restricted to listing/query flags in read-only mode');
}

function candidateArgValue(arg) {
  const eq = arg.indexOf('=');
  if (eq > 0 && arg.startsWith('-')) return arg.slice(eq + 1);
  const shortAttached = arg.match(/^-[A-Za-z](.+)$/)?.[1];
  if (shortAttached && (path.isAbsolute(shortAttached) || /(^|[\\/])\.\.([\\/]|$)/.test(shortAttached))) return shortAttached;
  return arg;
}

function validatePathArgument(value, cwd, roots) {
  if (!value || value === '-' || /^(?:https?|ssh|git):\/\//i.test(value)) return;
  const hasParent = /(^|[\\/])\.\.([\\/]|$)/.test(value);
  const absolute = path.isAbsolute(value);
  const candidate = absolute ? path.resolve(value) : path.resolve(cwd, value);
  const exists = fs.existsSync(candidate);
  if (!absolute && !hasParent && !exists) return;
  if (!roots.some((root) => containedIn(candidate, path.resolve(root)))) throw new Error(`command argument escapes the allowed roots: ${value}`);
  if (exists) resolveRealUnderRootSync(candidate, { roots });
}

export function validateAllowedCommandArgs(bin, args, cwd, { roots = getRoots() } = {}) {
  if (path.basename(bin).toLowerCase() === 'git') validateGitReadOnlyArgs(args);
  for (const raw of args) validatePathArgument(candidateArgValue(raw), cwd, roots);
}

class Shell {
  // Backslash is escape/chaining on Unix but the normal path separator on Windows — only treat it as dangerous off-Windows.
  // No backslash: `execFile` never spawns a shell, so it is an inert literal everywhere and a path separator on Windows.
  static DANGEROUS_CHARS = /[;&|`$<>\n]/;

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
    if (readSettings().shell?.allowAll === true) return 'unrestricted';
    const allowlist = loadAllowlist();
    if (bin in allowlist) {
      const allowedSubcommands = allowlist[bin];
      if (!Array.isArray(allowedSubcommands) || allowedSubcommands.includes(args[0])) return 'allowlist';
    }
    if (preallowedByDir(bin, args)) return 'trusted';
    throw new Error(`"${bin}${args[0] ? ` ${args[0]}` : ''}" is not in the allowlist`);
  }

  run(bin, args, cwd) {
    return new Promise((resolve) => {
      const target = resolveExecFileTarget(bin, args);
      execFile(target.file, target.args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          if (error.code === 'ENOENT') {
            return resolve(err(`executable not found: "${bin}". run_cmd does not invoke a command shell; use the dedicated MCP filesystem/search tools instead of shell built-ins.`));
          }
          const combined = [stdout, stderr].filter((part) => part && part.trim()).join('\n');
          return resolve(err(combined || error.message));
        }
        resolve(ok(stdout || stderr || '(no output)'));
      });
    });
  }

  async execute(command, cwd) {
    let bin, args, dir;
    try {
      ({ bin, args } = this.parse(command));
      dir = resolveRealUnderRootSync(cwd);
      const permission = this.checkPermission(bin, args);
      if (permission === 'allowlist') validateAllowedCommandArgs(bin, args, dir);
    } catch (e) {
      return fail(e);
    }
    return this.run(bin, args, dir);
  }
}

const shell = new Shell();

export function register(server) {
  server.registerTool(
    'run_cmd',
    {
      title: 'Run Command',
      description: 'Run one shell command. Default policy is the panel-managed read-only allowlist; owners may explicitly enable shell.allowAll to accept any executable name. Use the search tools (find_path/search_content) for file/text lookup. Pass cwd (absolute path under an allowed root, or relative to the first configured root) to run inside a specific project directory — this is how you target a repo. No chaining, no redirection — one command per call.',
      inputSchema: { command: z.string(), cwd: z.string().optional() },
    },
    ({ command, cwd }) => shell.execute(command, cwd),
  );
}

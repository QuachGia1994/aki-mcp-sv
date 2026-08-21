// Allowlist-gated shell MCP tool, in-house (npm `shell-mcp` has no real whitelist) — rationale: docs/plan/init.md
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadAllowlist, loadAllowlistDirs, readSettings } from './allowlist.js';
import { getRoots, resolveUnderRoot, containedIn, overlaps } from './roots.js';
import { ok, err, fail } from './mcp-tool.js';

// Interpreters run a script file passed as an argument, so trust must follow the script's path, not the interpreter binary (which lives on PATH, outside the trusted zones). Shells (sh/bash/zsh) are excluded on purpose — their argument is arbitrary code, not a file to locate under a zone.
const INTERPRETERS = new Set(['node', 'python', 'python3', 'bun', 'deno', 'tsx', 'ruby', 'perl', 'php']);

// ls-remote requires zero extra args — a repository/URL argument lets git's own ext:: transport helper spawn an arbitrary process before anything "read-only" happens; bare invocation only queries the configured remote.
const GIT_NO_ARGS_SUBCOMMANDS = new Set(['ls-remote']);

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
    if (readSettings().shell?.allowAll === true) return;
    const allowlist = loadAllowlist();
    if (bin in allowlist) {
      const allowedSubcommands = allowlist[bin];
      if (!Array.isArray(allowedSubcommands) || allowedSubcommands.includes(args[0])) {
        if (bin === 'git' && GIT_NO_ARGS_SUBCOMMANDS.has(args[0]) && args.length > 1) {
          throw new Error(`"git ${args[0]}" only allowed with no further arguments — a repository/URL argument can smuggle code execution via git's transport helpers (ext::, --upload-pack=)`);
        }
        return;
      }
    }
    if (preallowedByDir(bin, args)) return; // not named (or the named subcommand is blocked), but it targets a script under a trusted zone
    throw new Error(`"${bin}${args[0] ? ` ${args[0]}` : ''}" is not in the allowlist`);
  }

  run(bin, args, cwd) {
    return new Promise((resolve) => {
      execFile(bin, args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          resolve(err(stderr || error.message));
        } else {
          resolve(ok(stdout || '(no output)'));
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
      return fail(e);
    }
    return this.run(bin, args, dir);
  }
}

const shell = new Shell();

export function register(server) {
  const roots = getRoots();
  server.registerTool(
    'run_cmd',
    {
      title: 'Run Command',
      description: `Run one shell command. Default policy is the panel-managed read-only allowlist; owners may explicitly enable shell.allowAll to accept any executable name. Use the search tools (find_path/search_content) for file/text lookup. Pass cwd (absolute path under one of ${roots.join(', ')}, or relative to ${roots[0]}) to run inside a specific project directory — this is how you target a repo. No chaining, no redirection — one command per call.`,
      inputSchema: { command: z.string(), cwd: z.string().optional() },
    },
    ({ command, cwd }) => shell.execute(command, cwd),
  );
}

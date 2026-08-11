#!/usr/bin/env node
// One MCP process hosting all in-house tools (shell, agy, kiro, search) on a single McpServer — merges four Node runtimes into one (docs/plan/consolidate-mcp-tool-processes.md, Part A). Each domain's logic stays in its own register(server) module behind a stable contract.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { register as registerShell } from './shell-mcp.js';
import { register as registerAgy } from './agy-mcp.js';
import { register as registerKiro } from './kiro-mcp.js';
import { register as registerSearch } from './search-mcp.js';

const server = new McpServer({ name: 'local', version: '1.0.0', title: 'Local Tools' });

for (const register of [registerShell, registerAgy, registerKiro, registerSearch]) register(server);

await server.connect(new StdioServerTransport());

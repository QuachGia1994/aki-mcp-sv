// SQLite / Local database inspector tools (sqlite_schema / sqlite_query).
// Uses Node 22 built-in node:sqlite in strict read-only mode with root containment.
// Served names are prefixed local__ by tools-server.js.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ok, err, fail } from './mcp-tool.js';
import { resolveRealUnderRootSync } from './roots.js';

const WRITE_OR_ESCAPE_SQL = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|REPLACE|VACUUM|REINDEX)\b/i;
const READ_ONLY_PRAGMA = /^\s*PRAGMA\s+(?:table_info|table_xinfo|table_list|index_list|index_info|index_xinfo|foreign_key_list|database_list|compile_options)\s*(?:\([^;]*\))?\s*;?\s*$/i;

export function isReadOnlySql(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed || WRITE_OR_ESCAPE_SQL.test(trimmed)) return false;
  if (/^SELECT\b/i.test(trimmed)) return true;
  if (/^EXPLAIN\s+(?:QUERY\s+PLAN\s+)?SELECT\b/i.test(trimmed)) return true;
  if (/^WITH\b/i.test(trimmed)) return /\bSELECT\b/i.test(trimmed);
  return READ_ONLY_PRAGMA.test(trimmed);
}

export function register(server) {
  server.registerTool(
    'sqlite_schema',
    {
      title: 'Inspect SQLite database schema',
      description:
        'Read schema of a local SQLite database (.sqlite, .db, .sqlite3). Returns all tables, views, columns, and indexes.',
      inputSchema: {
        dbPath: z.string().describe('Absolute or relative path to SQLite database file within allowed roots'),
      },
    },
    async ({ dbPath }) => {
      let db = null;
      try {
        const abs = resolveRealUnderRootSync(dbPath);
        if (!existsSync(abs)) return err(`SQLite file not found: ${dbPath}`);

        db = new DatabaseSync(abs, { readOnly: true });
        const stmt = db.prepare(`
          SELECT type, name, tbl_name, sql
          FROM sqlite_master
          WHERE type IN ('table', 'view', 'index') AND name NOT LIKE 'sqlite_%'
          ORDER BY type, name
        `);
        const schema = stmt.all();
        return ok(JSON.stringify(schema, null, 2));
      } catch (e) {
        return fail(e);
      } finally {
        db?.close();
      }
    },
  );

  server.registerTool(
    'sqlite_query',
    {
      title: 'Execute read-only SQL query on SQLite database',
      description:
        'Execute a read-only SQL query (SELECT, PRAGMA, EXPLAIN, WITH) on a local SQLite database. Writes and DDL are strictly rejected. Output capped at 100 rows.',
      inputSchema: {
        dbPath: z.string().describe('Path to SQLite database file within allowed roots'),
        query: z.string().describe('Read-only SQL query to execute'),
        params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Positional SQL query parameters'),
      },
    },
    async ({ dbPath, query, params }) => {
      let db = null;
      try {
        const trimmed = (query || '').trim();
        if (!isReadOnlySql(trimmed)) {
          return err('Only read-only SELECT/EXPLAIN SELECT/WITH queries and approved inspection PRAGMAs are permitted.');
        }

        const abs = resolveRealUnderRootSync(dbPath);
        if (!existsSync(abs)) return err(`SQLite file not found: ${dbPath}`);

        db = new DatabaseSync(abs, { readOnly: true });
        const stmt = db.prepare(trimmed);
        const allRows = stmt.all(...(params || []));
        const MAX_ROWS = 100;
        const truncated = allRows.length > MAX_ROWS;
        const rows = truncated ? allRows.slice(0, MAX_ROWS) : allRows;

        return ok(JSON.stringify({
          totalRows: allRows.length,
          returnedRows: rows.length,
          truncated,
          rows,
        }, null, 2));
      } catch (e) {
        return fail(e);
      } finally {
        db?.close();
      }
    },
  );
}

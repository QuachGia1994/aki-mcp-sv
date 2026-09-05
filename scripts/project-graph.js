import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { USER_DIR } from './userdata.js';
import { pathIdentity, resolveOrFail } from './roots.js';
import { readJsonObject, writeJsonAtomic } from './user-state.js';
import { ok, err } from './mcp-tool.js';

export const GRAPH_STORE_PATH = path.join(USER_DIR, 'project-graphs.json');
const MAX_FILES = 80;
const MAX_TOTAL_CHARS = 500_000;
const MAX_FILE_CHARS = 80_000;
const MAX_ENTITIES = 1200;
const MAX_RELATIONS = 2400;
const SECRET_NAME_RE = /(^|[._-])(env|secret|secrets|credential|credentials|token|tokens|password|passwd|private[-_]?key|oauth)([._-]|$)|\.(pem|key|p12|pfx)$/i;
const SECRET_VALUE_RE = /(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{20,}|[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:token|secret|password|api[_ -]?key)\s*[:=]\s*\S{8,})/i;
const DURABLE_DIRS = ['docs/arch', 'docs/feat', 'docs/biz', 'docs/ref', 'docs/plan/done'];
const TOP_LEVEL = ['README.md', 'CHANGELOG.md', 'package.json'];

function projectKey(cwd) {
  return createHash('sha256').update(pathIdentity(cwd)).digest('hex').slice(0, 20);
}

function fingerprint(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function normalizeText(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  return normalizeText(text).match(/[\p{L}\p{N}_-]+/gu) || [];
}

function trigrams(text) {
  const value = `  ${normalizeText(text)}  `;
  const out = new Set();
  for (let i = 0; i < value.length - 2; i += 1) out.add(value.slice(i, i + 3));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function safeRelative(rel) {
  const normalized = rel.replace(/\\/g, '/');
  return !normalized.split('/').some((part) => SECRET_NAME_RE.test(part));
}

function entityId(type, sourcePath, label) {
  return createHash('sha1').update(`${type}\n${sourcePath}\n${label}`).digest('hex').slice(0, 16);
}

function addEntity(target, entity) {
  if (!entity.label || target.size >= MAX_ENTITIES) return null;
  const id = entity.id || entityId(entity.type, entity.source.path, entity.label);
  if (!target.has(id)) target.set(id, { ...entity, id });
  return id;
}

function addRelation(relations, from, to, type, source) {
  if (!from || !to || from === to || relations.length >= MAX_RELATIONS) return;
  const key = `${from}|${type}|${to}`;
  if (relations.some((item) => item.key === key)) return;
  relations.push({ key, from, to, type, source });
}

function durableFiles(cwd) {
  const out = [];
  let truncated = false;
  for (const name of TOP_LEVEL) {
    const absolute = path.join(cwd, name);
    if (existsSync(absolute)) {
      const info = lstatSync(absolute);
      if (info.isFile() && !info.isSymbolicLink()) out.push(absolute);
    }
  }
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    if (out.length >= MAX_FILES) { truncated = true; return; }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_FILES) { truncated = true; break; }
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && /\.(md|json)$/i.test(entry.name)) out.push(absolute);
    }
  };
  for (const rel of DURABLE_DIRS) walk(path.join(cwd, rel));
  return { files: out, truncated };
}

function collectDurableArtifactsDetailed(cwd) {
  const artifacts = [];
  let total = 0;
  let skippedLarge = 0;
  let charBudgetTruncated = false;
  const discovered = durableFiles(cwd);
  for (const absolute of discovered.files) {
    const rel = path.relative(cwd, absolute).replace(/\\/g, '/');
    if (!safeRelative(rel)) continue;
    const size = statSync(absolute).size;
    if (size > MAX_FILE_CHARS * 4) { skippedLarge += 1; continue; }
    const content = readFileSync(absolute, 'utf8').slice(0, MAX_FILE_CHARS);
    if (total + content.length > MAX_TOTAL_CHARS) { charBudgetTruncated = true; break; }
    total += content.length;
    artifacts.push({ path: rel, content, fingerprint: fingerprint(content) });
  }
  return { artifacts, coverage: { fileCapTruncated: discovered.truncated, charBudgetTruncated, skippedLarge, sourceFiles: artifacts.length, maxFiles: MAX_FILES, maxTotalChars: MAX_TOTAL_CHARS } };
}

export function collectDurableArtifacts(cwd) {
  return collectDurableArtifactsDetailed(cwd).artifacts;
}

function extractPackageJson(artifact, entities, relations, now) {
  try {
    const data = JSON.parse(artifact.content);
    const label = String(data.name || 'project');
    const projectId = addEntity(entities, { type: 'project', label, summary: data.version ? `version ${data.version}` : '', keywords: ['project', label, data.version || ''].filter(Boolean), source: { path: artifact.path, fingerprint: artifact.fingerprint }, lastVerified: now, confidence: 'high' });
    for (const [kind, deps] of [['dependency', data.dependencies], ['devDependency', data.devDependencies]]) {
      for (const name of Object.keys(deps || {}).slice(0, 120)) {
        const id = addEntity(entities, { type: 'component', label: name, summary: kind, keywords: [name, kind], source: { path: artifact.path, fingerprint: artifact.fingerprint }, lastVerified: now, confidence: 'high' });
        addRelation(relations, projectId, id, 'uses', artifact.path);
      }
    }
  } catch { /* malformed package metadata is ignored, never guessed */ }
}

function headingType(label) {
  if (/^\[?\d+\.\d+\.\d+\]?/.test(label)) return 'release';
  if (/decision/i.test(label)) return 'decision';
  if (/outcome|result/i.test(label)) return 'outcome';
  if (/architecture|design/i.test(label)) return 'architecture';
  return 'topic';
}

function extractMarkdown(artifact, entities, relations, now) {
  const docId = addEntity(entities, { type: 'document', label: artifact.path, summary: '', keywords: tokenize(artifact.path), source: { path: artifact.path, fingerprint: artifact.fingerprint }, lastVerified: now, confidence: 'high' });
  let currentHeading = '';
  let currentHeadingId = null;
  let facts = 0;
  for (const raw of artifact.content.split(/\r?\n/)) {
    const heading = raw.match(/^#{1,4}\s+(.+?)\s*$/)?.[1]?.replace(/[*`]/g, '').trim();
    if (heading && !SECRET_VALUE_RE.test(heading)) {
      currentHeading = heading;
      currentHeadingId = addEntity(entities, { type: headingType(heading), label: heading.slice(0, 240), summary: `section in ${artifact.path}`, keywords: tokenize(heading), source: { path: artifact.path, fingerprint: artifact.fingerprint }, lastVerified: now, confidence: 'high' });
      addRelation(relations, docId, currentHeadingId, 'contains', artifact.path);
      continue;
    }
    const bullet = raw.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1]?.replace(/\s+/g, ' ').trim();
    if (!bullet || facts >= 120 || SECRET_VALUE_RE.test(bullet)) continue;
    if (!/(decision|outcome|result|added|changed|fixed|architecture|acceptance|verification|evidence|completed|done|security|constraint)/i.test(`${currentHeading} ${bullet}`)) continue;
    const label = bullet.slice(0, 320);
    const id = addEntity(entities, { type: /decision/i.test(currentHeading) ? 'decision' : /outcome|result|completed|done/i.test(currentHeading) ? 'outcome' : 'fact', label, summary: currentHeading ? `under ${currentHeading}` : '', keywords: tokenize(`${currentHeading} ${bullet}`), source: { path: artifact.path, fingerprint: artifact.fingerprint }, lastVerified: now, confidence: 'medium' });
    addRelation(relations, currentHeadingId || docId, id, 'contains', artifact.path);
    facts += 1;
  }
}

export function extractArtifactEntities(cwd, artifacts, { now = Date.now() } = {}) {
  const entities = new Map();
  const relations = [];
  for (const artifact of artifacts) {
    if (!safeRelative(artifact.path)) continue;
    if (artifact.path === 'package.json') extractPackageJson(artifact, entities, relations, now);
    else if (/\.md$/i.test(artifact.path)) extractMarkdown(artifact, entities, relations, now);
  }
  return { entities: [...entities.values()], relations: relations.map(({ key, ...relation }) => relation) };
}

export function buildGraphSearchIndex(entities) {
  const docs = entities.map((entity) => {
    const text = `${entity.label} ${entity.summary || ''} ${(entity.keywords || []).join(' ')}`;
    const terms = tokenize(text);
    const tf = new Map();
    for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);
    return { entity, normalized: normalizeText(text), grams: trigrams(text), tf, length: Math.max(1, terms.length) };
  });
  const df = new Map();
  for (const doc of docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  const avgLength = docs.length ? docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length : 1;
  return { docs, df, avgLength };
}

function bm25(queryTerms, doc, index) {
  const k1 = 1.2;
  const b = 0.75;
  const n = Math.max(1, index.docs.length);
  let score = 0;
  for (const term of queryTerms) {
    const tf = doc.tf.get(term) || 0;
    if (!tf) continue;
    const df = index.df.get(term) || 0;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.length / index.avgLength)));
  }
  return score;
}

export function searchGraphIndex(query, index, { limit = 12, typeFilter = [] } = {}) {
  const normalizedQuery = normalizeText(query);
  const queryTerms = tokenize(query);
  const queryGrams = trigrams(query);
  const allowed = new Set(typeFilter || []);
  return index.docs
    .filter((doc) => !allowed.size || allowed.has(doc.entity.type))
    .map((doc) => {
      const exact = normalizedQuery && doc.normalized.includes(normalizedQuery) ? 20 : 0;
      const lexical = bm25(queryTerms, doc, index);
      const fuzzy = jaccard(queryGrams, doc.grams) * 5;
      const score = exact + lexical + fuzzy;
      return { entity: doc.entity, score: Math.round(score * 1000) / 1000, matchType: exact ? (lexical || fuzzy ? 'hybrid' : 'exact') : lexical && fuzzy ? 'hybrid' : lexical ? 'bm25' : 'trigram' };
    })
    .filter((item) => item.score > 0.15)
    .sort((a, b) => b.score - a.score || a.entity.label.localeCompare(b.entity.label))
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 12)));
}

function readStore() {
  const raw = readJsonObject(GRAPH_STORE_PATH, { version: 1, projects: {} });
  return { version: 1, projects: raw.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects) ? raw.projects : {} };
}

export function syncProjectGraph({ cwd }, { now = Date.now, load = readStore, save = (state) => writeJsonAtomic(GRAPH_STORE_PATH, state) } = {}) {
  const resolved = resolveOrFail(cwd);
  if (!resolved.ok) throw resolved.error;
  const started = now();
  const collected = collectDurableArtifactsDetailed(resolved.dir);
  const artifacts = collected.artifacts;
  const extracted = extractArtifactEntities(resolved.dir, artifacts, { now: started });
  const state = load();
  const key = projectKey(resolved.dir);
  state.projects[key] = { cwd: resolved.dir, lastIndexed: started, sourceFingerprint: fingerprint(artifacts.map((item) => `${item.path}:${item.fingerprint}`).join('\n')), entities: extracted.entities, relations: extracted.relations, sources: artifacts.map((item) => ({ path: item.path, fingerprint: item.fingerprint })), coverage: collected.coverage };
  save(state);
  return { project: resolved.dir, entityCount: extracted.entities.length, relationCount: extracted.relations.length, sourceCount: artifacts.length, coverage: collected.coverage, durationMs: Math.max(0, now() - started) };
}

export function recordProjectOutcome({ cwd, taskKey, summary, decisions = [] }, { now = Date.now, load = readStore, save = (state) => writeJsonAtomic(GRAPH_STORE_PATH, state) } = {}) {
  const resolved = resolveOrFail(cwd);
  if (!resolved.ok) throw resolved.error;
  const state = load();
  const key = projectKey(resolved.dir);
  const project = state.projects[key] || { cwd: resolved.dir, lastIndexed: 0, sourceFingerprint: '', entities: [], relations: [], sources: [] };
  const sourcePath = `task:${String(taskKey).slice(0, 120)}`;
  const safeSummary = SECRET_VALUE_RE.test(String(summary || '')) ? `Task ${taskKey} completed; sensitive summary omitted` : String(summary || taskKey);
  const safeDecisions = decisions.filter((decision) => !SECRET_VALUE_RE.test(String(decision))).slice(0, 32);
  const source = { path: sourcePath, fingerprint: fingerprint(`${safeSummary}\n${safeDecisions.join('\n')}`) };
  const entities = new Map(project.entities.map((entity) => [entity.id, entity]));
  const relations = project.relations.map((item) => ({ ...item, key: `${item.from}|${item.type}|${item.to}` }));
  const outcomeId = addEntity(entities, { type: 'outcome', label: safeSummary.slice(0, 320), summary: `task ${taskKey}`, keywords: tokenize(`${taskKey} ${safeSummary}`), source, lastVerified: now(), confidence: 'high' });
  for (const decision of safeDecisions) {
    const id = addEntity(entities, { type: 'decision', label: String(decision).slice(0, 320), summary: `task ${taskKey}`, keywords: tokenize(decision), source, lastVerified: now(), confidence: 'high' });
    addRelation(relations, outcomeId, id, 'records', sourcePath);
  }
  project.entities = [...entities.values()].slice(-MAX_ENTITIES);
  project.relations = relations.map(({ key: relationKey, ...rest }) => rest).slice(-MAX_RELATIONS);
  project.lastIndexed = Math.max(project.lastIndexed || 0, now());
  state.projects[key] = project;
  save(state);
  return { entityCount: project.entities.length, relationCount: project.relations.length };
}

export function getProjectGraphStatus(cwd) {
  const store = readStore();
  const projects = Object.values(store.projects);
  if (!cwd) return { projectCount: projects.length, projects: projects.map((project) => ({ cwd: project.cwd, entityCount: project.entities?.length || 0, relationCount: project.relations?.length || 0, lastIndexed: project.lastIndexed || 0 })) };
  const resolved = resolveOrFail(cwd);
  if (!resolved.ok) return { projectCount: projects.length, error: resolved.error.message };
  const project = store.projects[projectKey(resolved.dir)];
  return { projectCount: projects.length, currentProject: project ? { cwd: project.cwd, entityCount: project.entities?.length || 0, relationCount: project.relations?.length || 0, sourceCount: project.sources?.length || 0, lastIndexed: project.lastIndexed || 0, coverage: project.coverage || null } : null };
}

export function runGraphQuery({ query, cwd, limit = 12, typeFilter = [] }) {
  const resolved = resolveOrFail(cwd);
  if (!resolved.ok) return err(`rejected: ${resolved.error.message}`);
  const project = readStore().projects[projectKey(resolved.dir)];
  if (!project) return err('project graph is not indexed yet — run local__graph_sync for this cwd first');
  const results = searchGraphIndex(query, buildGraphSearchIndex(project.entities || []), { limit, typeFilter });
  return ok(JSON.stringify(results.map((item) => ({ score: item.score, matchType: item.matchType, type: item.entity.type, label: item.entity.label, summary: item.entity.summary, source: item.entity.source, lastVerified: item.entity.lastVerified, confidence: item.entity.confidence })), null, 2));
}

export function register(server) {
  server.registerTool('graph_query', { title: 'Aki Project Graph Query', description: 'Search compact durable project knowledge with exact + BM25-like lexical + trigram fuzzy retrieval. Results include provenance; graph stores derived facts only, not raw repo/chat dumps.', inputSchema: { query: z.string().min(1), cwd: z.string(), limit: z.number().int().min(1).max(50).optional().default(12), typeFilter: z.array(z.string()).optional().default([]) } }, runGraphQuery);
  server.registerTool('graph_sync', { title: 'Aki Project Graph Sync', description: 'Rebuild the compact project graph from durable non-secret artifacts only: README, CHANGELOG, package metadata, docs arch/feat/biz/ref and completed plans. Writes only ~/.aki/mcpsv graph state; never modifies the project.', inputSchema: { cwd: z.string() } }, async (args) => { try { return ok(JSON.stringify(syncProjectGraph(args), null, 2)); } catch (error) { return err(error.message || String(error)); } });
  server.registerTool('graph_status', { title: 'Aki Project Graph Status', description: 'Report compact project graph counts and last-index time.', inputSchema: { cwd: z.string().optional() } }, async ({ cwd }) => ok(JSON.stringify(getProjectGraphStatus(cwd), null, 2)));
}

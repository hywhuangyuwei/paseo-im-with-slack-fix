#!/usr/bin/env node
// Archive inactive Slack agents whose titles (paseo ls names) include Slack + dm.
// Default is read-only; pass --apply to change state.
// This uses the installed Paseo CLI's directory helper because `paseo ls --json`
// omits labels and activity timestamps. If that internal API changes, fail closed.
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.PASEO_HOME || join(homedir(), '.paseo');
const CLI = process.env.PASEO_CLI_DIST || join(homedir(), '.npm-global/lib/node_modules/@getpaseo/cli/dist');
const PASEO = process.env.PASEO_BIN || join(homedir(), '.npm-global/bin/paseo');
const AGE_MS = 24 * 60 * 60 * 1000;

export function matchesAgentTitle(agent) {
  // `paseo ls --json` exposes this directory field as `name`.
  return typeof agent?.title === 'string' && /slack/i.test(agent.title) && /dm/i.test(agent.title);
}

export function connectionIds(config) {
  if (!config || !Array.isArray(config.connections)) throw new Error('Invalid connections configuration');
  const found = config.connections.filter(c => c?.channel === 'slack');
  const ids = found.map(c => c.id);
  if (ids.some(id => typeof id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) ||
      new Set(ids).size !== ids.length) {
    throw new Error('Slack connections have invalid or duplicate IDs');
  }
  return ids;
}

export function explicitTargetIds(config, connection) {
  const entry = config.connections.find(c => c.id === connection);
  if (!entry || !entry.bindings || typeof entry.bindings !== 'object' || Array.isArray(entry.bindings)) {
    throw new Error('Invalid Slack dm routing configuration');
  }
  const targets = [entry.target, ...Object.values(entry.bindings)];
  const ids = new Set();
  for (const target of targets) {
    if (target?.kind === 'agent') {
      if (typeof target.agentId !== 'string' || !target.agentId) throw new Error('Invalid explicitly bound agent');
      ids.add(target.agentId);
    }
  }
  return ids;
}

export function eligible(agent, state, connection, now = Date.now(), explicitTargets = new Set()) {
  if (!matchesAgentTitle(agent) || explicitTargets.has(agent.id) || agent.archivedAt || agent.labels?.['im/connection'] !== connection ||
      typeof agent.labels?.['im/conversation'] !== 'string' ||
      !['idle', 'closed'].includes(agent.status)) return false;
  // Attention flags and timestamps are not archival filters. Treat metadata
  // updates and messages as activity; missing/invalid updatedAt is unsafe.
  const updated = Date.parse(agent.updatedAt);
  if (!Number.isFinite(updated)) return false;
  let latest = updated;
  for (const field of ['createdAt', 'lastUserMessageAt']) {
    if (agent[field] != null) {
      const t = Date.parse(agent[field]);
      if (!Number.isFinite(t)) return false;
      latest = Math.max(latest, t);
    }
  }
  if (latest > now - AGE_MS) return false;
  if (!state || typeof state.jobs !== 'object' || !state.jobs ||
      typeof state.conversations !== 'object' || !state.conversations) throw new Error('Invalid IM state');
  const conversation = agent.labels['im/conversation'];
  for (const job of Object.values(state.jobs)) {
    if (!job || typeof job !== 'object') throw new Error('Invalid IM job');
    const associated = job.agentId === agent.id ||
      (!job.agentId && job.conversationKey === conversation && state.conversations[conversation]?.agentId === agent.id);
    if (!associated) continue;
    if (job.delivery !== 'done' || job.followup ||
        (job.question && job.question.status !== 'answered')) return false;
    // IM-level activity can occur without a prompt reaching the agent yet.
    if (!Number.isFinite(job.updatedAt) || job.updatedAt > now - AGE_MS) return false;
  }
  const conv = state.conversations[conversation];
  if (conv?.agentId === agent.id && (!Number.isFinite(conv.updatedAt) || conv.updatedAt > now - AGE_MS)) return false;
  return true;
}

async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function run() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const onlyAt = args.indexOf('--only');
  const only = onlyAt < 0 ? null : args[onlyAt + 1];
  const opts = onlyAt < 0 ? args : args.filter((_, i) => i !== onlyAt && i !== onlyAt + 1);
  if (opts.some(a => !['--dry-run', '--apply'].includes(a)) ||
      (opts.includes('--dry-run') && opts.includes('--apply')) ||
      (onlyAt >= 0 && (!only || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(only))) ||
      (onlyAt >= 0 && args.lastIndexOf('--only') !== onlyAt)) {
    throw new Error('Usage: slack-dm-archive.mjs [--dry-run | --apply] [--only UUID]');
  }
  const configPath = `${HOME}/plugin-data/paseo-im/connections.json`;
  const config = await json(configPath);
  const connections = connectionIds(config);
  if (!connections.length) {
    console.log(`mode=${apply ? 'apply' : 'dry-run'} connections=0 matched=0 eligible=0`);
    return;
  }
  // Validate every matching connection before any archive operation.
  const contexts = new Map();
  for (const conn of connections) {
    const statePath = `${HOME}/plugin-data/paseo-im/connections/${conn}/state.json`;
    contexts.set(conn, { statePath, state: await json(statePath),
      explicitTargets: explicitTargetIds(config, conn) });
  }
  const { connectToDaemon } = await import(`${CLI}/utils/client.js`);
  const { fetchAllAgents } = await import(`${CLI}/utils/agent-directory.js`);
  const client = await connectToDaemon({ target: { kind: 'instance', home: HOME }, timeout: 10000 });
  let failed = false;
  try {
    const all = await fetchAllAgents(client, { filter: { includeArchived: false, includeBackground: true } });
    const matched = all.filter(agent => contexts.has(agent.labels?.['im/connection']) && matchesAgentTitle(agent));
    const candidates = matched.filter(agent => {
      const conn = agent.labels?.['im/connection'];
      const context = contexts.get(conn);
      return context && (!only || agent.id === only) &&
        eligible(agent, context.state, conn, Date.now(), context.explicitTargets);
    });
    console.log(`mode=${apply ? 'apply' : 'dry-run'} connections=${connections.length} agents=${all.length} matched=${matched.length} eligible=${candidates.length}`);
    for (const old of candidates) {
      if (!apply) { console.log(`would-archive id=${old.id} status=${old.status} updated=${old.updatedAt}`); continue; }
      // Re-read the complete live directory and IM state immediately before each
      // operation. Both connection identity and eligibility must still match.
      const latestConfig = await json(configPath);
      const conn = old.labels['im/connection'];
      if (!connectionIds(latestConfig).includes(conn)) throw new Error('Connection changed during run');
      const explicitTargets = explicitTargetIds(latestConfig, conn);
      const state = await json(contexts.get(conn).statePath);
      const current = (await fetchAllAgents(client, { filter: { includeArchived: false, includeBackground: true } })).find(a => a.id === old.id);
      if (!eligible(current, state, conn, Date.now(), explicitTargets)) { console.log(`skip-changed id=${old.id}`); continue; }
      // The CLI refuses running agents unless --force is used. Do not use it.
      const result = spawnSync(PASEO, ['--home', HOME, '--json', 'archive', old.id], {
        encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
      });
      if (result.status !== 0 || result.error) {
        failed = true;
        console.error(`archive-failed id=${old.id} exit=${result.status ?? 'unknown'}`);
        continue;
      }
      console.log(`archived id=${old.id}`);
    }
  } finally { await client.close(); }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(err => { console.error(`cleanup-error ${err.message}`); process.exitCode = 1; });
}

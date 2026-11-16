import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { connectionIds, eligible, explicitTargetIds, matchesAgentTitle } from './slack-dm-archive.mjs';
const now = Date.parse('2026-11-13T15:00:00Z');
const id = '1e8a9171-d203-4a49-b141-25003375759d';
const config = { connections: [{ id, name: 'Slack GCP', channel: 'slack', target:{kind:'workspace'}, bindings:{} }] };
const base = { id:'old', title:'Slack GCP · dm:chat-1:thread-1', status:'closed', archivedAt:null, requiresAttention:false,
  updatedAt:'2026-11-11T15:00:00Z', createdAt:'2026-11-11T14:00:00Z',
  lastUserMessageAt:'2026-11-11T14:30:00Z', labels:{'im/connection':id,'im/conversation':'dm:123:456'} };
const state = { jobs:{}, conversations:{} };
const check = (agent = base, s = state) => eligible(agent, s, id, now);
assert.deepEqual(connectionIds(config), [id]);
assert.deepEqual(connectionIds({connections:[]}), []);
assert.throws(() => connectionIds({connections:[...config.connections,...config.connections]}));
assert.throws(() => connectionIds({}));
// Connection names are not the target: Slack GCP must remain discoverable.
for (const name of ['Slack GCP', 'dm GCP', 'renamed connection', '', null]) {
  assert.deepEqual(connectionIds({connections:[{...config.connections[0],name}]}), [id]);
}
for (const title of ['Slack GCP · dm:chat-1:thread-1', 'dm / SLACK AWS', 'sLaCk GCP dM', 'Slack-dm-extra']) {
  assert.ok(matchesAgentTitle({title}));
  assert.ok(check({...base,title}));
}
for (const title of ['Slack GCP', 'dm GCP', 'Telegram dm', '', null, undefined]) {
  assert.ok(!matchesAgentTitle({title}));
  assert.ok(!check({...base,title}));
}
assert.ok(!matchesAgentTitle({name:'Slack dm'}));
assert.ok(!matchesAgentTitle(null));
assert.deepEqual(connectionIds({connections:[{...config.connections[0],channel:'telegram'}]}), []);
const second = {...config.connections[0], id:'2e8a9171-d203-4a49-b141-25003375759d', name:'dm Slack AWS'};
assert.deepEqual(connectionIds({connections:[config.connections[0],second]}), [id,second.id]);
assert.throws(() => connectionIds({connections:[{...second,id:'invalid'}]}));
assert.throws(() => connectionIds({connections:[{...second,id:'-'.repeat(36)}]}));
assert.deepEqual([...explicitTargetIds(config, id)], []);
const boundConfig = {connections:[{...config.connections[0],bindings:{a:{kind:'agent',agentId:'old'}}}]};
assert.ok(!eligible(base,state,id,now,explicitTargetIds(boundConfig,id)));
assert.throws(() => explicitTargetIds({connections:[{...config.connections[0],bindings:null}]}, id));
assert.ok(check());
assert.ok(check({...base,status:'idle'}));
assert.ok(check({...base,updatedAt:'2026-11-12T15:00:00Z'}));
assert.ok(!check({...base,updatedAt:'2026-11-12T15:00:01Z'}));
for (const status of ['running','initializing','error']) assert.ok(!check({...base,status}));
assert.ok(!check({...base,requiresAttention:true}));
assert.ok(!check({...base,archivedAt:'2026-11-12T01:00:00Z'}));
assert.ok(!check({...base,labels:{...base.labels,'im/connection':'other'}}));
assert.ok(!check({...base,labels:{'im/connection':id}}));
assert.ok(!check({...base,updatedAt:'invalid'}));
assert.ok(!check({...base,lastUserMessageAt:'2026-11-13T14:59:59Z'}));
assert.ok(!check(base,{...state, conversations:{'dm:123:456':{agentId:'old',updatedAt:now-1000}}}));
const job = {agentId:'old',conversationKey:'dm:123:456',delivery:'done',updatedAt:now-2*86400000};
assert.ok(check(base,{...state,jobs:{a:job}}));
for (const override of [{delivery:null},{delivery:'sending'},{delivery:'uncertain'},
  {followup:{pendingTasks:['x']}},{question:{status:'pending'}},{updatedAt:now-1000}]) {
  assert.ok(!check(base,{...state,jobs:{a:{...job,...override}}}));
}
assert.ok(!check(base,{jobs:{a:{...job,agentId:null,delivery:null}},conversations:{'dm:123:456':{agentId:'old',updatedAt:now-2*86400000}}}));
assert.throws(() => check(base,{}));
console.log('all fixture assertions passed');

// Subprocess coverage uses only synthetic config/state and a fake CLI; never
// contacts the production daemon or invokes the installed archive command.
test('CLI: connection without dm discovers agent titles; dry-run and pre-archive title recheck', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paseo-slack-archive-'));
  const home = join(root, 'home');
  const cli = join(root, 'cli');
  const log = join(root, 'archive-calls.jsonl');
  const binary = join(root, 'fake-paseo.cjs');
  try {
    const data = join(home, 'plugin-data/paseo-im');
    await mkdir(join(data, 'connections', id), {recursive:true});
    await mkdir(join(cli, 'utils'), {recursive:true});
    await writeFile(join(data, 'connections.json'), JSON.stringify(config));
    await writeFile(join(data, 'connections', id, 'state.json'), JSON.stringify(state));
    await writeFile(join(cli, 'package.json'), JSON.stringify({type:'module'}));
    await writeFile(join(cli, 'utils/client.js'), 'export async function connectToDaemon() { return {close:async()=>{}}; }');
    const oldId = '3e8a9171-d203-4a49-b141-25003375759d';
    const recentId = '4e8a9171-d203-4a49-b141-25003375759d';
    const old = {...base, id:oldId};
    const recent = {...base, id:recentId, updatedAt:new Date().toISOString()};
    // Misleading titles on another connection, or missing title, must not match.
    const unrelated = {...base, id:'unrelated', labels:{...base.labels,'im/connection':'other'}};
    const missingTitle = {...base, id:'missing', title:null};
    const agents = [old,recent,unrelated,missingTitle];
    await writeFile(join(cli, 'utils/agent-directory.js'), `
      import assert from 'node:assert/strict';
      let calls=0;
      export async function fetchAllAgents(client, options) {
        assert.deepEqual(options.filter, {includeArchived:false,includeBackground:true});
        const agents=${JSON.stringify(agents)};
        if (++calls > 1 && process.env.ARCHIVE_FIXTURE_RENAME === '1') agents[0].title='Unrelated task';
        return agents;
      }
    `);
    await writeFile(binary, `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.ARCHIVE_FIXTURE_LOG, JSON.stringify(process.argv.slice(2))+'\\n');\n`, {mode:0o700});
    const script = fileURLToPath(new URL('./slack-dm-archive.mjs', import.meta.url));
    const invoke = (args, extra = {}) => {
      const result = spawnSync(process.execPath, [script,...args], {
        encoding:'utf8', timeout:10000,
        env:{...process.env,PASEO_HOME:home,PASEO_CLI_DIST:cli,PASEO_BIN:binary,ARCHIVE_FIXTURE_LOG:log,ARCHIVE_FIXTURE_RENAME:'0',...extra},
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const output = invoke(['--dry-run']);
    assert.match(output, /connections=1 agents=4 matched=2 eligible=1/);
    assert.match(output, new RegExp(`would-archive id=${oldId}`));
    assert.doesNotMatch(output, new RegExp(`would-archive id=${recentId}`));
    await assert.rejects(readFile(log), {code:'ENOENT'});
    // Fake --apply validates the actual run path and that --force is absent.
    assert.match(invoke(['--apply']), new RegExp(`archived id=${oldId}`));
    assert.deepEqual((await readFile(log,'utf8')).trim().split('\n').map(JSON.parse), [[ '--home', home, '--json', 'archive', oldId ]]);
    await rm(log);
    assert.match(invoke(['--apply'], {ARCHIVE_FIXTURE_RENAME:'1'}), new RegExp(`skip-changed id=${oldId}`));
    await assert.rejects(readFile(log), {code:'ENOENT'});
  } finally {
    await rm(root, {recursive:true,force:true});
  }
});

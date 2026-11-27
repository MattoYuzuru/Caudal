import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectorCommands, countStatuses, formatBytes, formatObservation, formatUptime, ratio, recentSamples, type Metrics } from './domain.ts';

test('collector commands select the architecture and use the token file without embedding a credential', () => {
  const commands = collectorCommands('https://fleet.example.test/panel', 'node_1', 'arm64');
  assert.match(commands.download, /https:\/\/fleet\.example\.test\/downloads\/caudal-agent-linux-arm64/);
  assert.match(commands.configure, /umask 077/);
  assert.match(commands.configure, /read -rsp/);
  assert.match(commands.start, /CAUDAL_TOKEN_FILE="\$HOME\/\.config\/caudal\/node_1\.token"/);
  assert.throws(() => collectorCommands('https://fleet.example.test', '../evil', 'amd64'));
});

test('unobserved nodes and stale nodes have distinct counts', () => {
  const base = { id: '1', name: 'test', region: '', created_at: '' };
  assert.deepEqual(countStatuses([{ ...base, status: 'pending' }, { ...base, status: 'stale' }, { ...base, status: 'healthy' }]),
    { pending: 1, stale: 1, healthy: 1 });
});

test('resource and observation formatting covers missing, zero and bounded values', () => {
  assert.equal(formatBytes(0), '0 Б');
  assert.equal(formatBytes(1.5 * 1024 ** 3), '1,5 ГиБ');
  assert.equal(ratio(1, 0), 0);
  assert.equal(ratio(6, 4), 100);
  assert.equal(ratio(1, 4), 25);
  assert.equal(formatUptime(3 * 86_400 + 2 * 3_600), '3 д 2 ч');
  assert.equal(formatObservation(undefined), 'Нет данных');
  assert.equal(formatObservation('invalid'), 'Нет данных');
  assert.match(formatObservation('2026-11-27T12:30:01Z'), /12:30:01 UTC/);
});

test('history selects the most recent readings in chronology without editing the source', () => {
  const metrics: Metrics = { cpu_percent: 0, disk_total_bytes: 1, disk_used_bytes: 0, memory_total_bytes: 1, memory_used_bytes: 0, uptime_seconds: 0 };
  const samples = ['12', '16', '10', '14'].map(hour => ({ observed_at: `2026-11-27T${hour}:00:00Z`, metrics }));
  assert.deepEqual(recentSamples(samples, 2), [samples[3], samples[1]]);
  assert.match(samples[0].observed_at, /T12/);
});

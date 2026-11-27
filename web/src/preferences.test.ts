import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaults, readPreferences } from './preferences.ts';

test('saved preferences validate each value and include only known browser settings', () => {
  assert.deepEqual(readPreferences(null), defaults);
  assert.deepEqual(readPreferences('{invalid'), defaults);
  assert.deepEqual(readPreferences('null'), defaults);
  assert.deepEqual(readPreferences(JSON.stringify({ theme: 'dark', layout: 'multi', density: {}, interval: 92, live: false, unrecognized: 'ignored' })),
    { ...defaults, theme: 'dark', layout: 'multi', live: false });
});

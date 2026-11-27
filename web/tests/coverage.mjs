import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import istanbul from 'istanbul-lib-coverage';

const coverage = istanbul.createCoverageMap();
for (const file of await readdir('test-results', { recursive: true })) {
  if (file.endsWith('/coverage.json')) coverage.merge(JSON.parse(await readFile(resolve('test-results', file), 'utf8')));
}

const expected = (await readdir('src', { recursive: true }))
  .filter(file => /\.tsx?$/.test(file) && !file.endsWith('.test.ts') && !file.startsWith('aspect/') && file !== 'main.tsx');
const missing = expected.filter(file => !coverage.files().includes(resolve('src', file)));
if (missing.length > 0) throw new Error(`Missing browser coverage for ${missing.join(', ')}`);

for (const file of coverage.files().sort()) {
  const summary = coverage.fileCoverageFor(file).toSummary();
  console.log(`${relative('.', file).padEnd(41)} ${String(summary.lines.pct).padStart(6)}% lines`);
}
const total = coverage.getCoverageSummary().toJSON();
console.log(`Browser coverage: ${total.lines.pct}% lines, ${total.statements.pct}% statements, ${total.functions.pct}% functions, ${total.branches.pct}% branches`);
if (total.lines.pct < 70 || total.statements.pct < 70) throw new Error('Caudal browser coverage must reach 70% for lines and statements.');

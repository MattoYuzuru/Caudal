import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { FleetNode, Metrics, OperationRun } from '../src/domain';

const timestamp = '2026-11-27T15:30:00Z';
const metrics: Metrics = { cpu_percent: 22, memory_used_bytes: 2 ** 31, memory_total_bytes: 2 ** 32, disk_used_bytes: 2 ** 32, disk_total_bytes: 2 ** 34, uptime_seconds: 181_200 };
const server: FleetNode = { id: 'node-1', name: 'Север', region: 'Стокгольм', created_at: timestamp, last_seen: timestamp, status: 'healthy', metrics };
const stale: FleetNode = { ...server, id: 'node-2', name: 'Восток', region: 'Хельсинки', status: 'stale' };
const fixtureSecret = 'fixture-only-collector-token';
const fixtureKey = 'fixture-deepseek-key';
const runId = 'a11ce9'.repeat(5) + 'aa';
const cancellationId = 'ca11ce11ed'.repeat(3) + 'ca';
const report = [
  '## Показатели', '', '- **Доступная память**', '', '```text', 'данные сборщика', '```', '',
  `[Справка](https://example.invalid/reference) · [Строка результата](#run-${runId}-L3)`, '',
  `[Неизвестная строка](#run-${runId}-L999) · [Незащищённая ссылка](http://example.invalid)`, '',
  '![Трекинг](https://example.invalid/pixel.png)', '', '<aside>Скрытая вставка</aside>',
].join('\n');
const plan: OperationRun = {
  id: runId, status: 'awaiting_approval', operations: [
    { id: 'fleet.host', label: 'Обзор узла', transport: 'fleet', target: 'Узел Север', method: 'snapshot', effect: 'read' },
    { id: 'fleet.history', label: 'История', transport: 'fleet', target: 'Узел Север', effect: 'read' },
  ],
};
const completed: OperationRun = { ...plan, status: 'completed', results: [
  { operation_id: 'fleet.host', status: 'ok', duration_ms: 12, lines: ['CPU 22%', 'Память 2 ГиБ'] },
  { operation_id: 'fleet.history', status: 'unknown', duration_ms: 41, lines: ['Свежесть не подтверждена'] },
] };

type Scenario = {
  authenticated: boolean;
  nodes: FleetNode[];
  fleetFailure?: boolean;
  sessionFailure?: boolean;
  historyFailure?: boolean;
  assistantFailure?: string;
  operationFixture?: boolean;
  receiptExpired?: boolean;
  approvalConflict?: boolean;
  approvalGate?: Promise<void>;
  serverTime?: string;
  requests: { path: string; method: string; body?: unknown }[];
};

async function start(page: Page, initial: Partial<Scenario> = {}, destination = '/') {
  const state: Scenario = { authenticated: true, nodes: [server, stale], requests: [], ...initial };
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    const body = request.postDataJSON();
    state.requests.push({ path, method, body });
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === '/session') {
      if (method === 'DELETE') {
        state.authenticated = false;
        return route.fulfill({ status: 204 });
      }
      if (method === 'POST') {
        if (body?.password !== 'fixture-owner-password') return json({ error: 'invalid_password' }, 401);
        state.authenticated = true;
      }
      return state.sessionFailure ? json({}, 500) : json({ authenticated: state.authenticated });
    }
    if (!state.authenticated) return json({ error: 'authentication_required' }, 401);
    if (path === '/fleet') return state.fleetFailure ? route.abort('failed') : json({ nodes: state.nodes, server_time: state.serverTime });
    if (path === '/fleet/events') return route.abort('failed');
    if (path === '/assistant/status') return json({ deepseek_configured: false });
    if (path === '/nodes') {
      const node: FleetNode = { id: 'test-created', name: body.name, region: body.region, created_at: timestamp, status: 'pending' };
      state.nodes = [...state.nodes, node];
      return json({ node, token: fixtureSecret }, 201);
    }
    if (path.endsWith('/samples')) {
      if (state.historyFailure) return json({ error: 'storage_error' }, 500);
      const node = state.nodes.find(item => path === `/nodes/${item.id}/samples`);
      return json({ samples: node?.metrics ? [
        { observed_at: '2026-11-27T15:29:00Z', metrics: { ...metrics, cpu_percent: 8 } },
        { observed_at: '2026-11-27T15:29:30Z', metrics: { ...metrics, cpu_percent: 15 } },
        { observed_at: timestamp, metrics },
      ] : [] });
    }
    if (path.endsWith('/rotate')) return json({ token: 'fixture-rotated-collector-token' });
    if (path === `/runs/${runId}` && method === 'GET' && state.operationFixture) {
      return state.receiptExpired ? json({ error: 'operation_run_not_found' }, 404) : json({ run: completed });
    }
    if (path === `/runs/${runId}/approve` && state.operationFixture) {
      if (state.approvalConflict) return json({ error: 'operation_in_progress' }, 409);
      await state.approvalGate;
      return json({ run: completed });
    }
    if (path === `/runs/${cancellationId}/cancel` && state.operationFixture) {
      return json({ run: { ...plan, id: cancellationId, status: 'cancelled' } });
    }
    if (path === '/assistant' && state.operationFixture) {
      if (body.run_id) return json({ answer: `[Ссылка от ассистента](#run-${runId}-L1)`, source: body.mode, evidence: [] });
      const run = body.message === 'Второй запуск' ? { ...plan, id: cancellationId } : plan;
      return json({ answer: report, source: body.mode, evidence: [], run });
    }
    if (path === '/assistant') return state.assistantFailure && body.mode === 'deepseek' ? json({ error: state.assistantFailure }, 503) : json({
      answer: 'Узел Север на связи. У Востока данные устарели.', source: body.mode,
      evidence: [server, stale].filter(node => !body.node_id || node.id === body.node_id)
        .map(node => ({ node_id: node.id, name: node.name, status: node.status, observed_at: node.last_seen })),
    });
    return json({ error: 'node_not_found' }, 404);
  });
  await page.goto(destination);
  return state;
}

async function enterProviderKey(page: Page) {
  await page.getByRole('button', { name: 'Настройки подключения' }).click();
  await page.getByLabel('Ключ API DeepSeek').fill(fixtureKey);
  await page.getByRole('button', { name: 'Ассистент', exact: true }).click();
}

async function screenshot(page: Page, name: string) {
  if (process.env.CAUDAL_SCREENSHOTS) {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(process.env.CAUDAL_SCREENSHOTS, `${name}.png`), fullPage: true });
  }
}

test.afterEach(async ({ page }, testInfo) => {
  const data = await page.evaluate(() => (window as Window & { __coverage__?: Record<string, unknown> }).__coverage__);
  if (!data) return;
  const output = testInfo.outputPath('coverage.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(data));
});

test('owner sign-in rejects a wrong password, supports keyboard entry and clears the session on logout', async ({ page }) => {
  const state = await start(page, { authenticated: false, nodes: [] });
  await expect(page.getByRole('heading', { name: 'Вход в Caudal' })).toBeVisible();
  await screenshot(page, 'login');
  const password = page.getByLabel('Пароль');
  await password.fill('wrong');
  await password.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Неверный пароль');
  await expect(password).toHaveValue('');
  await password.fill('fixture-owner-password');
  await password.press('Enter');
  await expect(page.getByRole('heading', { name: 'Подключите первый узел' })).toBeVisible();
  await screenshot(page, 'onboarding');
  await expect(page.locator('header').getByRole('button', { name: 'Выйти' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вход в Caudal' })).toBeVisible();
  expect(state.authenticated).toBe(false);
});

test('empty fleet enrolls a Linux host and surfaces the token only in setup', async ({ page }) => {
  const state = await start(page, { nodes: [] });
  const enroll = page.getByRole('button', { name: 'Настроить сборщик' });
  await enroll.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Подключить узел');
  await dialog.getByLabel('Имя узла').fill('Лаборатория');
  await dialog.getByLabel('Регион').fill('Москва');
  await dialog.getByRole('button', { name: 'Создать узел' }).click();
  await expect(dialog).toHaveAccessibleName('Настройка сборщика');
  await dialog.getByLabel('Архитектура сервера').selectOption('arm64');
  await expect(dialog.getByText(/caudal-agent-linux-arm64/)).toBeVisible();
  const token = dialog.getByLabel('Токен сборщика', { exact: true });
  await expect(token).toHaveAttribute('type', 'password');
  await dialog.getByRole('button', { name: 'Показать' }).click();
  await expect(token).toHaveValue(fixtureSecret);
  await dialog.getByRole('button', { name: 'Скрыть' }).click();
  await dialog.getByRole('button', { name: 'К узлу' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Лаборатория', exact: true })).toBeVisible();
  await expect(page.getByText('Сборщик ещё не отправил метрики.')).toBeVisible();
  expect(state.requests.find(item => item.path === '/nodes')?.body).toEqual({ name: 'Лаборатория', region: 'Москва' });
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain(fixtureSecret);
});

test('desktop fleet exposes live sample history and downgrades statuses on a refresh failure', async ({ page }) => {
  const state = await start(page);
  await expect(page.getByRole('heading', { name: 'Парк серверов' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Восток/ })).toBeVisible();
  await screenshot(page, 'fleet-desktop');
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(scan.violations).toEqual([]);
  await page.getByRole('button', { name: /^Север/ }).click();
  await expect(page.getByRole('heading', { name: 'Север', exact: true })).toBeVisible();
  await page.getByText('Данные графика').click();
  await expect(page.getByRole('cell', { name: '22%' })).toBeVisible();
  await screenshot(page, 'node-desktop');
  state.fleetFailure = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('alert')).toContainText('Показаны последние доступные данные');
  await expect(page.getByText('Был на связи', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'К списку' }).click();
  await expect(page.getByRole('alert')).toContainText('последняя доступная сводка');
  state.fleetFailure = false;
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a healthy signal ages while the long polling interval is idle', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-27T13:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-27T13:01:00Z'));
  await page.addInitScript(() => localStorage.setItem('caudal.preferences.v1', JSON.stringify({ interval: 120, live: false })));
  const state = await start(page, { serverTime: '2026-11-27T15:31:29Z' });
  const node = page.getByRole('button', { name: /^Север/ });
  await expect(node).toContainText('На связи');
  const requests = state.requests.filter(item => item.path === '/fleet').length;
  await page.clock.runFor(1_200);
  await expect(node).toContainText('Данные устарели');
  expect(state.requests.filter(item => item.path === '/fleet')).toHaveLength(requests);
});

test('mobile assistant sends the selected scope and deliberate provider key, then exposes evidence', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await start(page);
  await expect(page.getByRole('button', { name: /^Север/ })).toBeVisible();
  await screenshot(page, 'fleet-mobile');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole('button', { name: /^Север/ }).click();
  await page.getByRole('button', { name: 'Ассистент', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ассистент', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'DeepSeek', exact: true }).click();
  await expect(page.getByText('DeepSeek получит вопрос', { exact: false })).toBeVisible();
  await expect(page.locator('.assistant').getByLabel('Ключ API')).toHaveCount(0);
  await enterProviderKey(page);
  await page.getByLabel('Модель', { exact: true }).selectOption('deepseek-v4-pro');
  await page.getByLabel('Рассуждение', { exact: true }).selectOption('high');
  await page.getByRole('button', { name: 'Какие узлы требуют внимания?' }).click();
  await page.getByRole('button', { name: 'Отправить вопрос' }).click();
  await expect(page.getByText('Узел Север на связи. У Востока данные устарели.')).toBeVisible();
  expect(state.requests.find(item => item.path === '/assistant')?.body).toMatchObject({ node_id: 'node-1', api_key: fixtureKey, mode: 'deepseek', model: 'deepseek-v4-pro', effort: 'high', auto_approve_read: false });
  await page.locator('summary').filter({ hasText: 'Снимки' }).click();
  await expect(page.getByRole('button', { name: 'Север', exact: true })).toBeVisible();
  await screenshot(page, 'assistant-mobile');
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(scan.violations).toEqual([]);
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Удалить ключ' }).click();
  await expect(page.getByLabel('Ключ API DeepSeek')).toHaveValue('');
  await page.getByRole('button', { name: 'Ассистент', exact: true }).click();
  await page.getByRole('button', { name: 'Север', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Север', exact: true })).toBeVisible();
});

test('rotating a token requires confirmation and gives the scoped replacement', async ({ page }) => {
  const state = await start(page);
  await page.getByRole('button', { name: /^Восток/ }).click();
  await page.getByRole('button', { name: 'Заменить токен' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Старый токен узла «Восток» перестанет работать сразу.');
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  expect(state.requests.filter(item => item.path.endsWith('/rotate'))).toHaveLength(0);
  await page.getByRole('button', { name: 'Заменить токен' }).click();
  await dialog.getByRole('button', { name: 'Заменить токен' }).click();
  await expect(dialog.getByLabel('Токен сборщика', { exact: true })).toHaveValue('fixture-rotated-collector-token');
  await expect(dialog.getByText(/node-2\.token/).first()).toBeVisible();
  expect(state.requests.filter(item => item.path.endsWith('/rotate'))).toEqual([{ path: '/nodes/node-2/rotate', method: 'POST', body: null }]);
});

test('session, history and deepseek errors each offer a way to recover', async ({ page }) => {
  const state = await start(page, { sessionFailure: true, historyFailure: true, assistantFailure: 'deepseek_not_configured' });
  await expect(page.getByRole('alert')).toBeVisible();
  state.sessionFailure = false;
  await page.getByRole('button', { name: 'Повторить' }).click();
  await page.getByRole('button', { name: /^Восток/ }).click();
  await expect(page.getByRole('alert')).toContainText('Хранилище временно недоступно');
  state.historyFailure = false;
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByText('Данные графика')).toBeVisible();
  await page.getByRole('button', { name: 'Ассистент', exact: true }).click();
  await page.getByRole('button', { name: 'DeepSeek', exact: true }).click();
  await enterProviderKey(page);
  await page.getByRole('textbox', { name: 'Вопрос ассистенту' }).fill('Что происходит?');
  await page.getByRole('button', { name: 'Отправить вопрос' }).click();
  await expect(page.getByRole('alert')).toContainText('Добавьте ключ DeepSeek');
  await page.getByRole('button', { name: 'Использовать локальную сводку' }).click();
  await page.getByRole('button', { name: 'Отправить вопрос' }).click();
  await expect(page.getByText('Узел Север на связи. У Востока данные устарели.')).toBeVisible();
  expect(state.requests.filter(item => item.path === '/assistant').at(-1)?.body).toMatchObject({ message: 'Что происходит?', mode: 'local' });
  expect(state.requests.filter(item => item.path === '/assistant').at(-1)?.body).not.toHaveProperty('api_key');
  state.authenticated = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('heading', { name: 'Вход в Caudal' })).toBeVisible();
});

test('assistant renders Markdown, turns receipt fragments into links after approval, and supports contextual follow-up', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const external: string[] = [];
  page.on('request', request => { if (new URL(request.url()).hostname === 'example.invalid') external.push(request.url()); });
  const state = await start(page, { operationFixture: true, approvalConflict: true });
  await page.getByRole('button', { name: 'Ассистент', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ассистент', exact: true })).toBeFocused();
  const question = page.getByRole('textbox', { name: 'Вопрос ассистенту' });
  await question.focus();
  await expect(question).toBeFocused();
  expect(await question.evaluate(element => ({
    input: getComputedStyle(element).outlineStyle,
    composer: getComputedStyle(element.closest('form')!).outlineStyle,
  }))).toEqual({ input: 'none', composer: 'solid' });
  await question.fill('Собери показатели');
  await page.getByRole('button', { name: 'Отправить вопрос' }).click();

  await expect(page.getByRole('heading', { name: 'Показатели' })).toBeVisible();
  await expect(page.locator('.assistant-markdown li strong')).toHaveText('Доступная память');
  await expect(page.locator('.assistant-markdown pre code')).toContainText('данные сборщика');
  const link = page.getByRole('link', { name: 'Справка', exact: true });
  await expect(link).toHaveAttribute('href', 'https://example.invalid/reference');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(page.locator('.assistant-markdown img, .assistant-markdown aside')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Неизвестная строка|Незащищённая ссылка|Строка результата/ })).toHaveCount(0);

  const receipt = page.getByRole('region', { name: 'Операции ассистента' });
  await expect(receipt).toContainText('Узел Север');
  await expect(receipt.getByText('Чтение', { exact: true })).toHaveCount(2);
  await expect(receipt).toContainText('Ожидает подтверждения');
  expect(state.requests.find(item => item.path === '/assistant')?.body).toMatchObject({ auto_approve_read: false });
  expect(state.requests.some(item => item.path.endsWith('/approve'))).toBe(false);
  await receipt.getByRole('button', { name: 'Подтвердить запуск' }).click();
  await expect(receipt.getByRole('alert')).toBeVisible();
  await expect(receipt).toContainText('Ожидает подтверждения');

  state.approvalConflict = false;
  let release = () => {};
  state.approvalGate = new Promise<void>(resolve => { release = resolve; });
  try {
    await receipt.getByRole('button', { name: 'Подтвердить запуск' }).click();
    await expect(receipt.getByRole('button', { name: 'Подтверждаем…' })).toBeDisabled();
    await expect(receipt.getByRole('button', { name: 'Отменить запуск' })).toBeDisabled();
  } finally {
    release();
  }
  await expect(receipt.getByText('Завершён')).toHaveAttribute('data-tone', 'warning');
  await expect(receipt).toContainText('Результат не подтверждён');
  await expect(receipt.locator('[id^="run-"]')).toHaveCount(3);
  await expect(receipt.locator(`#run-${runId}-L3`)).toContainText('Свежесть не подтверждена');
  await receipt.getByRole('button', { name: 'Скопировать ссылку на строку 3' }).click();
  expect(new URL(await page.evaluate(() => navigator.clipboard.readText())).hash).toBe(`#run-${runId}-L3`);
  await page.getByRole('link', { name: 'Строка результата', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#run-${runId}-L3$`));
  await expect(page.locator(':target')).toHaveAttribute('id', `run-${runId}-L3`);
  await screenshot(page, 'assistant-receipts');
  await receipt.getByRole('button', { name: 'Спросить по результату' }).click();
  await expect(question).toBeFocused();
  await expect(question).toHaveValue('Что важно в этом результате?');
  await page.getByRole('button', { name: 'Отправить вопрос' }).click();
  await expect(page.getByRole('link', { name: 'Ссылка от ассистента' })).toHaveAttribute('href', `#run-${runId}-L1`);
  expect(state.requests.filter(item => item.path === '/assistant').at(-1)?.body).toMatchObject({ run_id: runId, mode: 'local' });
  await page.getByRole('button', { name: 'Убрать результат из контекста' }).click();
  await question.fill('Второй запуск');
  await page.getByRole('button', { name: 'Отправить вопрос' }).click();
  await page.getByRole('button', { name: 'Отменить запуск' }).click();
  await expect(page.getByRole('region', { name: 'Операции ассистента' }).last()).toContainText('Отменено');
  expect(state.requests.filter(item => item.path === `/runs/${runId}/approve`)).toHaveLength(2);
  expect(state.requests.filter(item => item.path === `/runs/${cancellationId}/cancel`)).toHaveLength(1);
  expect(external).toEqual([]);
});

test('a receipt permalink opens after reload within the authenticated session and reports expiration', async ({ page }) => {
  const anchor = `run-${runId}-L3`;
  const state = await start(page, { operationFixture: true }, `/#${anchor}`);
  const line = page.locator(`#${anchor}`);
  await expect(line).toContainText('Свежесть не подтверждена');
  await expect(line).toBeFocused();
  await expect(page.getByText('Квитанция по ссылке')).toBeVisible();
  const firstReads = state.requests.filter(item => item.path === `/runs/${runId}`).length;
  expect(firstReads).toBeGreaterThan(0);

  await page.reload();
  await expect(line).toBeFocused();
  await expect(page.getByRole('button', { name: 'Подтвердить запуск' })).toHaveCount(0);
  expect(state.requests.filter(item => item.path === `/runs/${runId}`).length).toBeGreaterThan(firstReads);
  await page.evaluate(value => { window.location.hash = value; }, `run-${runId}-L99`);
  await expect(page.getByRole('alert')).toContainText('В квитанции нет строки с таким номером');

  state.receiptExpired = true;
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Квитанция недоступна');
  await expect(line).toHaveCount(0);
  expect(state.requests.filter(item => item.path === '/assistant' || item.path.startsWith('/runs/')).every(item => item.method === 'GET')).toBe(true);
});

test('the composer can switch a selected node to fleet-wide scope', async ({ page }) => {
  const state = await start(page);
  await page.getByRole('button', { name: /^Север/ }).click();
  await page.getByRole('button', { name: 'Ассистент', exact: true }).click();
  await page.getByRole('button', { name: 'Все узлы', exact: true }).click();
  await expect(page.locator('.composer-label')).toHaveText('Все узлы');
  await page.getByRole('textbox', { name: 'Вопрос ассистенту' }).fill('Сводка всех узлов');
  await page.getByRole('button', { name: 'Отправить вопрос' }).click();
  await expect(page.getByText('Узел Север на связи. У Востока данные устарели.')).toBeVisible();
  const request = state.requests.find(item => item.path === '/assistant');
  expect(request?.body).toMatchObject({ message: 'Сводка всех узлов' });
  expect(request?.body).not.toHaveProperty('node_id');
  await page.getByRole('button', { name: 'К выбранному узлу' }).click();
  await expect(page.locator('.composer-label')).toHaveText('Север');
});

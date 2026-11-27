import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { FleetNode, Metrics } from '../src/domain';

const timestamp = '2026-11-27T15:30:00Z';
const metrics: Metrics = { cpu_percent: 22, memory_used_bytes: 2 ** 31, memory_total_bytes: 2 ** 32, disk_used_bytes: 2 ** 32, disk_total_bytes: 2 ** 34, uptime_seconds: 181_200 };
const server: FleetNode = { id: 'node-1', name: 'Север', region: 'Стокгольм', created_at: timestamp, last_seen: timestamp, status: 'healthy', metrics };
const stale: FleetNode = { ...server, id: 'node-2', name: 'Восток', region: 'Хельсинки', status: 'stale' };
const fixtureSecret = 'fixture-only-collector-token';
const fixtureKey = 'fixture-deepseek-key';

type Scenario = {
  authenticated: boolean;
  nodes: FleetNode[];
  fleetFailure?: boolean;
  sessionFailure?: boolean;
  historyFailure?: boolean;
  assistantFailure?: string;
  requests: { path: string; method: string; body?: unknown }[];
};

async function start(page: Page, initial: Partial<Scenario> = {}) {
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
    if (path === '/fleet') return state.fleetFailure ? route.abort('failed') : json({ nodes: state.nodes });
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
    if (path === '/assistant') return state.assistantFailure ? json({ error: state.assistantFailure }, 503) : json({
      answer: 'Узел Север на связи. У Востока данные устарели.', source: 'deepseek',
      evidence: [server, stale].filter(node => !body.node_id || node.id === body.node_id)
        .map(node => ({ node_id: node.id, name: node.name, status: node.status, observed_at: node.last_seen })),
    });
    return json({ error: 'node_not_found' }, 404);
  });
  await page.goto('/');
  return state;
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
  await page.getByRole('button', { name: 'Выйти' }).click();
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
  const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }));
  expect(storage).toEqual({ local: 0, session: 0 });
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
  await page.getByRole('button', { name: 'Обновить парк' }).click();
  await expect(page.getByRole('alert')).toContainText('Показаны последние доступные данные');
  await expect(page.getByText('Был на связи', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'К списку' }).click();
  await expect(page.getByRole('alert')).toContainText('последняя доступная сводка');
  state.fleetFailure = false;
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
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
  await expect(page.getByText('DeepSeek получит вопрос', { exact: false })).toBeVisible();
  await page.getByText('Настройки DeepSeek', { exact: true }).click();
  await page.getByLabel('Ключ API').fill(fixtureKey);
  await page.getByRole('button', { name: 'Какие узлы требуют внимания?' }).click();
  await page.getByRole('button', { name: 'Отправить вопрос' }).click();
  await expect(page.getByText('Узел Север на связи. У Востока данные устарели.')).toBeVisible();
  expect(state.requests.find(item => item.path === '/assistant')?.body).toMatchObject({ node_id: 'node-1', api_key: fixtureKey });
  await page.locator('summary').filter({ hasText: 'Снимки' }).click();
  await expect(page.getByRole('button', { name: 'Север', exact: true })).toBeVisible();
  await screenshot(page, 'assistant-mobile');
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(scan.violations).toEqual([]);
  await page.getByRole('button', { name: 'Удалить ключ' }).click();
  await expect(page.getByLabel('Ключ API')).toHaveValue('');
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
  await page.getByRole('textbox', { name: 'Вопрос ассистенту' }).fill('Что происходит?');
  await page.getByRole('button', { name: 'Отправить вопрос' }).click();
  await expect(page.getByRole('alert')).toContainText('Добавьте ключ DeepSeek');
  state.authenticated = false;
  await page.getByRole('button', { name: 'Обновить парк' }).click();
  await expect(page.getByRole('heading', { name: 'Вход в Caudal' })).toBeVisible();
});

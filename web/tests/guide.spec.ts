import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { FleetNode, Metrics } from '../src/domain';

const metrics: Metrics = {
  cpu_percent: 17, memory_used_bytes: 2 ** 30, memory_total_bytes: 2 ** 32,
  disk_used_bytes: 2 ** 32, disk_total_bytes: 2 ** 34, uptime_seconds: 78100,
};
const configuredProxy = {
  id: 'fixture-proxy', label: 'Прокси-пример', web_url: 'https://teleport.example.invalid', status: 'not_checked',
};

function server(id: string, name: string, ageMs: number): FleetNode {
  const now = Date.now();
  return { id, name, region: '', created_at: new Date(now - 86_400_000).toISOString(),
    last_seen: new Date(now - ageMs).toISOString(), status: ageMs < 90_000 ? 'healthy' : 'stale', metrics };
}

async function workspace(page: Page, nodes: FleetNode[] = []) {
  const paths: string[] = [];
  const controls = { failingNode: '', failingProxy: false };
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.slice('/api/v1'.length);
    const method = request.method();
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    paths.push(`${method} ${path}`);
    if (path === '/session') return json({ authenticated: true });
    if (path === '/fleet/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: fleet\ndata: {}\n\n' });
    if (path === '/fleet') return json({ nodes, control_plane_node_id: 'panel-host' });
    if (path === '/nodes' && method === 'POST') {
      const node: FleetNode = { id: 'new-fixture', name: request.postDataJSON().name, region: '',
        created_at: new Date().toISOString(), status: 'pending' };
      nodes.push(node);
      return json({ node, token: 'test-collector-token' }, 201);
    }
    const sampleNode = nodes.find(node => path === `/nodes/${node.id}/samples`);
    if (sampleNode) return sampleNode.id === controls.failingNode ? json({ error: 'storage_error' }, 500)
      : json({ samples: sampleNode.last_seen ? [{ observed_at: sampleNode.last_seen, metrics }] : [] });
    if (path === '/teleport') return json({ profiles: [configuredProxy] });
    if (path === '/teleport/fixture-proxy/check' && method === 'POST') {
      if (controls.failingProxy) return json({ profile: { ...configuredProxy, status: 'unreachable', error: 'tls_certificate', checked_at: new Date().toISOString() } });
      return json({ profile: { ...configuredProxy, status: 'reachable', checked_at: new Date().toISOString(), latency_ms: 31 } });
    }
    return json({ error: 'node_not_found' }, 404);
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Маршруты', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Подключение и проверка' })).toBeVisible();
  return { paths, controls, nodes };
}

async function screenshot(page: Page, name: string) {
  if (!process.env.CAUDAL_SCREENSHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(process.env.CAUDAL_SCREENSHOTS, `${name}.png`), fullPage: true });
}

test.afterEach(async ({ page }, testInfo) => {
  const data = await page.evaluate(() => (window as Window & { __coverage__?: Record<string, unknown> }).__coverage__);
  if (!data) return;
  const output = testInfo.outputPath('coverage.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(data));
});

test('the mobile training guide demonstrates all stages without API probes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { paths } = await workspace(page);
  await page.getByRole('button', { name: 'Учебный пример' }).click();
  await expect(page.getByText(/Узлы и результаты вымышлены/)).toBeVisible();
  await page.getByLabel('Архитектура Linux').selectOption('arm64');
  await page.getByRole('button', { name: 'Получить учебный сигнал' }).click();
  await expect(page.getByText('Север', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Перейти к диагностике' }).click();
  await expect(page.getByRole('heading', { name: 'Диагностика по измерениям' })).toBeFocused();
  await page.getByLabel('Узел для диагностики').selectOption('lab-east');
  await page.getByRole('button', { name: 'Прочитать историю' }).click();
  await expect(page.getByText('История загружена · 2')).toBeVisible();
  await expect(page.getByText('28,9%', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Проверить два узла' }).click();
  await page.getByRole('button', { name: 'Сверить сигналы двух узлов' }).click();
  await expect(page.locator('.guide').getByText('Данные устарели', { exact: true })).toBeVisible();
  await expect(page.getByText(/два отдельных соединения с Caudal/)).toBeVisible();
  await page.getByText('Как устроен SSH через промежуточный узел').click();
  await expect(page.getByText(/Состояние SSH проверяется отдельно/)).toBeVisible();
  await page.getByRole('button', { name: 'Учебная проверка' }).click();
  await expect(page.getByText('Прокси отвечает')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Открыть Teleport' })).toHaveCount(0);
  expect(paths.filter(path => /samples|teleport|POST/.test(path))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const scan = await new AxeBuilder({ page }).include('.guide').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(scan.violations).toEqual([]);
  await screenshot(page, 'guide-training-mobile');
});

test('node setup carries the chosen architecture and reports a new collector signal', async ({ page }) => {
  const { paths, nodes } = await workspace(page);
  await page.getByLabel('Архитектура Linux').selectOption('arm64');
  await page.getByRole('button', { name: 'Подключить узел' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Имя узла').fill('Новая нода');
  await dialog.getByRole('button', { name: 'Создать узел' }).click();
  await expect(dialog.getByLabel('Архитектура сервера')).toHaveValue('arm64');
  await expect(dialog.getByText(/caudal-agent-linux-arm64/)).toBeVisible();
  expect(paths).toContain('POST /nodes');
  await dialog.getByRole('button', { name: 'Вернуться к маршруту' }).click();
  await expect(page.locator('.guide').getByText('Ожидает данные', { exact: true })).toBeVisible();
  nodes[0] = { ...nodes[0], last_seen: new Date().toISOString(), status: 'healthy', metrics };
  await expect(page.getByRole('button', { name: 'Перейти к диагностике' })).toBeVisible();
});

test('real guide reads history, distinguishes a known delivery path and checks the configured Teleport proxy', async ({ page }) => {
  const { paths, controls } = await workspace(page, [server('source-host', 'Север', 5_000), server('panel-host', 'Панель', 8_000), server('other-host', 'Восток', 130_000)]);
  await page.getByRole('button', { name: /Диагностика/ }).click();
  await page.getByLabel('Узел для диагностики').selectOption('other-host');
  await page.getByRole('button', { name: 'Прочитать историю' }).click();
  await expect(page.getByText('История загружена · 1')).toBeVisible();
  await page.getByRole('button', { name: 'Спросить ассистента об узле' }).click();
  await expect(page.getByRole('heading', { name: 'Ассистент', exact: true })).toBeFocused();
  await expect(page.locator('.composer-label')).toHaveText('Восток');
  expect(paths).toContain('GET /nodes/other-host/samples');
  await page.getByRole('button', { name: 'Маршруты', exact: true }).click();
  await page.getByRole('button', { name: /Несколько VPS/ }).click();
  await page.getByLabel('Источник').selectOption('source-host');
  await page.getByLabel('Второй узел').selectOption('panel-host');
  await page.getByRole('button', { name: 'Сверить сигналы двух узлов' }).click();
  await expect(page.getByText('Север → Caudal на Панель', { exact: true })).toBeVisible();
  expect(paths).toContain('GET /nodes/source-host/samples');
  expect(paths).toContain('GET /nodes/panel-host/samples');
  await expect(page.getByRole('link', { name: 'Открыть Teleport' })).toHaveAttribute('href', 'https://teleport.example.invalid/');
  await expect(page.getByRole('link', { name: 'Открыть Teleport' })).toHaveAttribute('target', '_blank');
  await page.getByRole('button', { name: 'Проверить прокси' }).click();
  await expect(page.getByText('Прокси отвечает')).toBeVisible();
  await expect(page.getByText('31 мс')).toBeVisible();
  expect(paths).toContain('POST /teleport/fixture-proxy/check');
  await screenshot(page, 'guide-fleet-desktop');

  controls.failingProxy = true;
  await page.getByRole('button', { name: 'Проверить прокси' }).click();
  await expect(page.getByText('Проверка не прошла')).toBeVisible();
  await expect(page.getByText(/Caudal не смог проверить сертификат TLS/)).toBeVisible();
  controls.failingNode = 'source-host';
  await page.getByRole('button', { name: 'Сверить сигналы двух узлов' }).click();
  await expect(page.getByText(/нужен свежий сигнал с узла-источника/)).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Хранилище временно недоступно');
  await expect(page.getByText('Север → Caudal на Панель', { exact: true })).toHaveCount(0);
});

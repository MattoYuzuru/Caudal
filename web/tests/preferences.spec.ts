import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { FleetNode } from '../src/domain';

const at = '2026-11-27T15:30:00Z';
const metrics = { cpu_percent: 23, memory_used_bytes: 2 ** 30, memory_total_bytes: 2 ** 31, disk_used_bytes: 2 ** 32, disk_total_bytes: 2 ** 34, uptime_seconds: 3600 };
const a: FleetNode = { id: 'node-a', name: 'Север', region: 'Стокгольм', created_at: at, last_seen: at, status: 'healthy', metrics };
const b: FleetNode = { ...a, id: 'node-b', name: 'Юг', region: 'Хельсинки', status: 'stale' };

async function session(page: Page) {
  await page.route('**/api/v1/session', route => route.fulfill({ json: { authenticated: true } }));
  await page.route('**/api/v1/fleet/events', route => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/assistant/status', route => route.fulfill({ json: { deepseek_configured: false } }));
  await page.route('**/api/v1/nodes/*/samples', route => route.fulfill({ json: { samples: [] } }));
}

async function screen(page: Page, name: string) {
  if (!process.env.CAUDAL_SCREENSHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(process.env.CAUDAL_SCREENSHOTS, `${name}.png`), fullPage: true });
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}

test.afterEach(async ({ page }, testInfo) => {
  const data = await page.evaluate(() => (window as Window & { __coverage__?: Record<string, unknown> }).__coverage__);
  if (!data) return;
  const output = testInfo.outputPath('coverage.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(data));
});

test('theme, layout, density and transport preferences persist and adapt to the phone', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await session(page);
  await page.route('**/api/v1/fleet', route => route.fulfill({ json: { nodes: [a, b] } }));
  await page.goto('/');
  const html = page.locator('html');
  const nav = page.getByRole('navigation', { name: 'Рабочая область' });
  const settings = nav.getByRole('button', { name: 'Настройки', exact: true });
  const fleet = nav.getByRole('button', { name: 'Парк', exact: true });
  await expect(html).toHaveAttribute('data-ca-theme', 'dark');
  await expect(page.locator('link[rel=icon]')).toHaveAttribute('href', '/caudal-dark.svg');
  await expect(page.getByRole('button', { name: /^Север/ })).toBeVisible();
  await expect(page.locator('.flow-trace').last()).toHaveCSS('animation-name', 'none');
  await screen(page, 'fleet-dark');
  await settings.click();
  await expect(page.getByRole('heading', { name: 'Настройки', exact: true })).toBeFocused();
  await page.getByRole('radio', { name: 'Светлая', exact: true }).check();
  await expect(html).toHaveAttribute('data-ca-theme', 'light');
  await expect(page.locator('link[rel=icon]')).toHaveAttribute('href', '/caudal-light.svg');
  await page.getByRole('radio', { name: 'Компактная', exact: true }).check();
  await page.getByRole('radio', { name: /^Мультиконсоль/ }).check();
  await page.getByRole('checkbox', { name: 'Получать обновления в реальном времени' }).uncheck();
  await page.getByLabel('Интервал проверки').selectOption('60');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  const axe = () => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect((await axe()).violations).toEqual([]);
  await screen(page, 'settings-light-mobile');
  await fleet.click();
  await expect(page.getByRole('heading', { name: 'Мультиконсоль', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Левая панель', exact: true })).toHaveValue('node-a');
  await expect(page.getByRole('combobox', { name: 'Правая панель', exact: true })).toHaveValue('node-b');
  await screen(page, 'compare-mobile');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Мультиконсоль', exact: true })).toBeVisible();
  await expect(html).toHaveAttribute('data-ca-theme', 'light');
  await page.getByRole('button', { name: 'SRE', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Север/ })).toContainText('23%');
  await expect(page.getByRole('heading', { name: 'Ассистент', exact: true })).toBeHidden();
  await expect(page.locator('.app-shell')).toHaveAttribute('data-density', 'compact');
  await page.getByRole('button', { name: 'Агент', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Вопрос ассистенту' });
  await composer.fill('Сохранить черновик');
  await settings.click();
  await page.getByRole('radio', { name: 'Как в системе', exact: true }).check();
  await expect(html).toHaveAttribute('data-ca-theme', 'dark');
  await expect(page.getByRole('checkbox', { name: 'Получать обновления в реальном времени' })).not.toBeChecked();
  await expect(page.getByLabel('Интервал проверки')).toHaveValue('60');
  expect((await axe()).violations).toEqual([]);
  await screen(page, 'settings-dark-mobile');
  await fleet.click();
  await expect(composer).toHaveValue('Сохранить черновик');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html).toHaveAttribute('data-ca-theme', 'light');
  await page.setViewportSize({ width: 1440, height: 910 });
  await page.getByRole('button', { name: 'Обзор', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Север/ })).toBeVisible();
  await screen(page, 'fleet-light');
});

test('live fleet events preserve reads during a burst and coalesce the next request', async ({ page }) => {
  await session(page);
  await page.addInitScript(() => {
    class FixtureEventSource extends EventTarget {
      closed = false;
      onerror?: () => void;
      static connections: FixtureEventSource[] = [];
      constructor() { super(); FixtureEventSource.connections.push(this); }
      close() { this.closed = true; }
    }
    (window as unknown as { EventSource: typeof FixtureEventSource }).EventSource = FixtureEventSource;
  });
  let requests = 0;
  let expired = false;
  const first = gate();
  const second = gate();
  await page.route('**/api/v1/fleet', async route => {
    const index = ++requests;
    if (index === 1) await first.promise;
    if (index === 2) await second.promise;
    if (expired) return route.fulfill({ status: 401, json: { error: 'authentication_required' } });
    await route.fulfill({ json: { nodes: index === 1 ? [a] : [{ ...a, name: 'Север, второй снимок' }] } });
  });
  await page.goto('/');
  await page.waitForFunction(() => (EventSource as unknown as { connections: { closed: boolean }[] }).connections.some(source => !source.closed));
  const emit = (count: number) => page.evaluate(number => {
    const active = (EventSource as unknown as { connections: (EventTarget & { closed: boolean })[] }).connections.findLast(source => !source.closed);
    for (let index = 0; index < number; index++) active?.dispatchEvent(new Event('fleet'));
  }, count);

  await emit(1);
  await expect.poll(() => requests).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: 'В реальном времени' })).toBeVisible();
  await emit(4);
  expect(requests).toBe(1);
  first.resolve();
  await expect(page.getByRole('button', { name: /^Север Стокгольм/ })).toBeVisible();
  await expect.poll(() => requests).toBe(2);
  second.resolve();
  await expect(page.getByRole('button', { name: /^Север, второй снимок/ })).toBeVisible();
  expect(requests).toBe(2);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => requests).toBe(3);
  expired = true;
  await page.evaluate(() => {
    const active = (EventSource as unknown as { connections: { closed: boolean; onerror?: () => void }[] }).connections.findLast(source => !source.closed);
    active?.onerror?.();
  });
  await expect(page.getByRole('heading', { name: 'Вход в Caudal' })).toBeVisible();
});

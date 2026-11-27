import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function settings(page: Page) {
  const mutations: string[] = [];
  await page.route('**/api/v1/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') mutations.push(path);
    if (path.endsWith('/session')) return route.fulfill({ json: { authenticated: true } });
    if (path.endsWith('/fleet')) return route.fulfill({ json: { nodes: [] } });
    if (path.endsWith('/assistant/status')) return route.fulfill({ json: { deepseek_configured: false } });
    if (path.endsWith('/teleport')) return route.fulfill({ json: { profiles: [] } });
    if (path.endsWith('/operations')) return route.fulfill({ json: { operations: [] } });
    return route.fulfill({ status: 404 });
  });
  await page.goto('/');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const navigation = page.getByRole('navigation', { name: 'Рабочая область' });
  await navigation.getByRole('button', { name: 'Настройки', exact: true }).click();
  return { mutations, launch: page.getByRole('region', { name: 'Пошаговые подсказки' }) };
}

async function expectAnchored(page: Page, target: string) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAttribute('data-anchored', 'true');
  await expect.poll(() => page.evaluate(name => {
    const anchor = document.querySelector(`[data-tour="${name}"]`)?.getBoundingClientRect();
    const spotlight = document.querySelector('.tour-spotlight')?.getBoundingClientRect();
    const card = document.querySelector('.tour-popover')?.getBoundingClientRect();
    return Boolean(anchor && spotlight && card && Math.abs(anchor.left - spotlight.left - 4) < 2 &&
      Math.abs(anchor.top - spotlight.top - 4) < 2 && card.left >= 0 && card.right <= window.innerWidth + 1 &&
      card.top >= 0 && card.bottom <= window.innerHeight + 1);
  }, target)).toBe(true);
}

async function screenshot(page: Page, name: string) {
  if (!process.env.CAUDAL_SCREENSHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(process.env.CAUDAL_SCREENSHOTS, `${name}.png`) });
}

test.afterEach(async ({ page }, testInfo) => {
  const data = await page.evaluate(() => (window as Window & { __coverage__?: Record<string, unknown> }).__coverage__);
  if (!data) return;
  const output = testInfo.outputPath('coverage.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(data));
});

test('VPS tour starts only in settings and follows real control positions with keyboard focus', async ({ page }) => {
  const { mutations, launch } = await settings(page);
  const launcher = launch.getByRole('button', { name: /^Подключить VPS/ });
  await launcher.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Зарегистрируйте узел');
  await expect(dialog.getByRole('heading')).toBeFocused();
  await expectAnchored(page, 'fleet-enroll');
  await screenshot(page, 'tour-vps-desktop');
  const scan = await new AxeBuilder({ page }).include('.tour-overlay').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(scan.violations).toEqual([]);
  await expect(dialog.getByRole('button', { name: 'Назад' })).toBeDisabled();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Далее' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveAccessibleName('Найдите первый сигнал');
  await expectAnchored(page, 'fleet-list');
  await dialog.getByRole('button', { name: 'Назад' }).click();
  await expect(dialog).toHaveAccessibleName('Зарегистрируйте узел');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(launcher).toBeFocused();
  expect(mutations).toEqual([]);
});

test('agent and connection tours navigate distinct targets on compact mobile and restore the selected launcher', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 724 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const { mutations, launch } = await settings(page);
  const agent = launch.getByRole('button', { name: /^Работа с агентом/ });
  const connection = launch.getByRole('button', { name: /^Подключения/ });
  const dialog = page.getByRole('dialog');
  await agent.click();
  await expect(dialog).toHaveAccessibleName('Выберите источник ответа');
  await expectAnchored(page, 'assistant-provider');
  await dialog.getByRole('button', { name: 'Далее' }).click();
  await expectAnchored(page, 'assistant-composer');
  await screenshot(page, 'tour-agent-mobile');
  await dialog.getByRole('button', { name: 'Далее' }).click();
  await expectAnchored(page, 'settings-approval');
  await expect(dialog.getByRole('heading')).toBeFocused();
  await dialog.getByRole('button', { name: 'Готово' }).click();
  await expect(agent).toBeFocused();
  await connection.click();
  await expectAnchored(page, 'connections-tabs');
  await dialog.getByRole('button', { name: 'Далее' }).click();
  await expectAnchored(page, 'connections-catalog');
  await dialog.getByRole('button', { name: 'Далее' }).click();
  await expectAnchored(page, 'connections-teleport');
  await dialog.getByRole('button', { name: 'Закрыть подсказку' }).click();
  await expect(connection).toBeFocused();
  expect(mutations).toEqual([]);
});

test('PWA exposes separate transparent, maskable and Apple touch icons', async ({ page, request }) => {
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  const any = manifest.icons.filter((entry: { purpose: string }) => entry.purpose === 'any');
  const maskable = manifest.icons.filter((entry: { purpose: string }) => entry.purpose === 'maskable');
  expect(any.map((entry: { sizes: string }) => entry.sizes)).toEqual(['192x192', '512x512']);
  expect(maskable).toHaveLength(1);
  expect(maskable[0].src).not.toBe(any[1].src);
  await settings(page);
  const apple = await page.locator('link[rel=apple-touch-icon]').getAttribute('href');
  expect(apple).toBe('/caudal-apple-touch.png');
  const check = async (src: string, size: number, colorType: number) => {
    const response = await request.get(src);
    expect(response.ok()).toBe(true);
    const png = await response.body();
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[25]]).toEqual([size, size, colorType]);
  };
  await Promise.all([check(any[0].src, 192, 6), check(any[1].src, 512, 6), check(maskable[0].src, 512, 2), check(apple!, 180, 2)]);
});

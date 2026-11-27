import { useEffect, useLayoutEffect, useState } from 'react';

export const preferenceKey = 'caudal.preferences.v1';
export const intervals = [15, 30, 60, 120] as const;
export const themes = ['system', 'light', 'dark'] as const;
export const layouts = ['overview', 'agent', 'sre', 'multi'] as const;
export const densities = ['comfortable', 'compact'] as const;

export type Theme = typeof themes[number];
export type Layout = typeof layouts[number];
export type Density = typeof densities[number];
export type Interval = typeof intervals[number];
export type Preferences = { theme: Theme; layout: Layout; density: Density; interval: Interval; live: boolean };

export const defaults: Preferences = { theme: 'system', layout: 'overview', density: 'comfortable', interval: 30, live: true };

function member<T>(values: readonly T[], value: unknown, fallback: T): T {
  return values.includes(value as T) ? value as T : fallback;
}

export function readPreferences(raw: string | null): Preferences {
  try {
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<Preferences> | null;
    return {
      theme: member(themes, saved?.theme, defaults.theme),
      layout: member(layouts, saved?.layout, defaults.layout),
      density: member(densities, saved?.density, defaults.density),
      interval: member(intervals, saved?.interval, defaults.interval),
      live: typeof saved?.live === 'boolean' ? saved.live : defaults.live,
    };
  } catch {
    return defaults;
  }
}

function loadPreferences() {
  try {
    return readPreferences(window.localStorage.getItem(preferenceKey));
  } catch {
    return defaults;
  }
}

export function usePreferences() {
  const [preferences, setPreferences] = useState(loadPreferences);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const activeTheme = preferences.theme === 'system' ? systemDark ? 'dark' : 'light' : preferences.theme;

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key === preferenceKey || event.key === null) setPreferences(readPreferences(event.newValue));
    }
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  useLayoutEffect(() => {
    const html = document.documentElement;
    html.dataset.caTheme = activeTheme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', activeTheme === 'dark' ? '#0c1123' : '#f8f2e9');
    document.querySelector('link[rel="icon"]')?.setAttribute('href', `/caudal-${activeTheme}.svg`);
    document.querySelector('link[rel="icon"]')?.setAttribute('type', 'image/svg+xml');
  }, [activeTheme]);

  function update(patch: Partial<Preferences>) {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    try {
      window.localStorage.setItem(preferenceKey, JSON.stringify(next));
    } catch {
      // Browser settings can disable local storage. The current tab keeps the choices.
    }
  }

  return { preferences, update };
}

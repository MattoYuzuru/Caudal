import { Activity, Download, LayoutDashboard, LogOut, MonitorCog, Moon, PanelsTopLeft, Radio, Sparkles, Sun } from 'lucide-react';
import { Button } from '../aspect/controls';
import { intervals, type Layout, type Preferences } from '../preferences';
import type { SyncStatus } from '../fleetSync';
import { BrandMark, Notice } from './common';

export const modes = [
  { id: 'overview', label: 'Обзор', icon: LayoutDashboard, detail: 'Парк и ассистент рядом.' },
  { id: 'agent', label: 'Агент', icon: Sparkles, detail: 'Диалог на всю ширину.' },
  { id: 'sre', label: 'SRE', icon: Activity, detail: 'Телеметрия всех узлов в списке.' },
  { id: 'multi', label: 'Мультиконсоль', icon: PanelsTopLeft, detail: 'Два узла для сравнения.' },
] as const satisfies readonly { id: Layout; label: string; icon: typeof Activity; detail: string }[];

const appearances = [
  { id: 'system', label: 'Как в системе', icon: MonitorCog },
  { id: 'light', label: 'Светлая', icon: Sun },
  { id: 'dark', label: 'Тёмная', icon: Moon },
] as const;

const statusLabels: Record<SyncStatus, string> = {
  live: 'В реальном времени',
  polling: 'По интервалу',
  connecting: 'Подключение…',
  offline: 'Связь прервана',
};
const syncTime = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

export function SyncIndicator({ status, updatedAt, announce = false }: { status: SyncStatus; updatedAt?: number; announce?: boolean }) {
  return <div className="sync-indicator">
    <span className={`sync-state sync-${status}`} role={announce ? 'status' : undefined}><i />{statusLabels[status]}</span>
    {updatedAt !== undefined && <time dateTime={new Date(updatedAt).toISOString()} className="sync-time" title="Последнее успешное обновление">{syncTime.format(updatedAt)} UTC</time>}
  </div>;
}

export function ModeSwitch({ mode, onChange }: { mode: Layout; onChange: (mode: Layout) => void }) {
  return <div className="mode-toolbar" role="group" aria-label="Режим рабочего пространства">
    {modes.map(({ id, label, icon: Icon }) => <Button className="mode-switch" key={id} variant="ghost" aria-pressed={mode === id} onClick={() => onChange(id)}>
      <Icon size={16} aria-hidden="true" /> {label}
    </Button>)}
  </div>;
}

export function Settings({ preferences, update, status, updatedAt, onRecover, fetching, onLogout, signingOut, logoutError, onInstall }: {
  preferences: Preferences;
  update: (patch: Partial<Preferences>) => void;
  status: SyncStatus;
  updatedAt?: number;
  onRecover: () => void;
  fetching: boolean;
  onLogout: () => void;
  signingOut: boolean;
  logoutError: string;
  onInstall?: () => void;
}) {
  return <section className="settings-page" aria-labelledby="settings-heading">
    <div className="view-heading"><div><h1 id="settings-heading" tabIndex={-1}>Настройки</h1><p>Внешний вид, рабочее пространство и обновление данных.</p></div></div>
    <div className="settings-grid">
      <section className="panel settings-card" aria-labelledby="appearance-title">
        <div className="panel-heading"><div><h2 id="appearance-title">Внешний вид</h2><p>Настройки сохраняются в этом браузере</p></div><Sun size={18} aria-hidden="true" /></div>
        <div className="settings-card-body">
          <fieldset className="settings-fieldset"><legend>Тема</legend>
            <div className="preference-choices theme-choices">
              {appearances.map(({ id, label, icon: Icon }) => <label className="preference-choice" key={id}>
                <input type="radio" name="theme" checked={preferences.theme === id} onChange={() => update({ theme: id })} />
                <span className={`theme-swatch theme-swatch-${id}`} aria-hidden="true"><Icon size={17} /></span><span>{label}</span>
              </label>)}
            </div>
          </fieldset>
          <fieldset className="settings-fieldset"><legend>Плотность списка</legend>
            <div className="preference-choices density-choices">
              <label className="preference-choice"><input type="radio" name="density" checked={preferences.density === 'comfortable'} onChange={() => update({ density: 'comfortable' })} /> Свободная</label>
              <label className="preference-choice"><input type="radio" name="density" checked={preferences.density === 'compact'} onChange={() => update({ density: 'compact' })} /> Компактная</label>
            </div>
          </fieldset>
        </div>
      </section>
      <section className="panel settings-card" aria-labelledby="layout-title">
        <div className="panel-heading"><div><h2 id="layout-title">Рабочее пространство</h2><p>Режим при открытии парка</p></div><PanelsTopLeft size={18} aria-hidden="true" /></div>
        <div className="settings-card-body">
          <fieldset className="settings-fieldset"><legend className="sr-only">Режим рабочего пространства</legend>
            <div className="preference-choices layout-choices">
              {modes.map(({ id, label, icon: Icon, detail }) => <label className="preference-choice" key={id}>
                <input type="radio" name="layout" checked={preferences.layout === id} onChange={() => update({ layout: id })} />
                <Icon size={16} aria-hidden="true" /><span><strong>{label}</strong><small>{detail}</small></span>
              </label>)}
            </div>
          </fieldset>
        </div>
      </section>
      <section className="panel settings-card" aria-labelledby="sync-title">
        <div className="panel-heading"><div><h2 id="sync-title">Обновление данных</h2><p>Caudal обновляет снимки в открытой вкладке</p></div><Radio size={18} aria-hidden="true" /></div>
        <div className="settings-card-body">
          <label className="preference-choice sync-toggle"><input type="checkbox" checked={preferences.live} onChange={event => update({ live: event.target.checked })} /> Получать обновления в реальном времени</label>
          <label className="field sync-interval"><span>Интервал проверки</span>
            <select className="aspect-input" value={preferences.interval} onChange={event => {
              const next = intervals.find(value => value === Number(event.target.value));
              if (next) update({ interval: next });
            }}>{intervals.map(value => <option value={value} key={value}>{value} сек.</option>)}</select>
            <small>Проверка ловит пропущенные события и замечает, когда сигналы узлов устарели.</small>
          </label>
          <div className="setting-actions sync-actions"><SyncIndicator status={status} updatedAt={updatedAt} /><Button onClick={onRecover} disabled={fetching}>Проверить связь</Button></div>
        </div>
      </section>
      <section className="panel settings-card" aria-labelledby="session-title">
        <div className="panel-heading"><div><h2 id="session-title">Сеанс</h2><p>Доступ к этой панели Caudal</p></div></div>
        <div className="settings-card-body">
          <div className="profile-row"><BrandMark /><div><strong>Владелец</strong><small>Сеанс активен</small></div></div>
          {logoutError && <Notice>{logoutError}</Notice>}
          <div className="setting-actions">
            {onInstall && <Button variant="ghost" onClick={onInstall} aria-haspopup="dialog"><Download size={16} aria-hidden="true" /> Установить Caudal</Button>}
            <Button onClick={onLogout} disabled={signingOut}><LogOut size={16} aria-hidden="true" />{signingOut ? 'Завершаем…' : 'Выйти'}</Button>
          </div>
        </div>
      </section>
    </div>
  </section>;
}

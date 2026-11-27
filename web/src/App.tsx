import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Download, LayoutGrid, LockKeyhole, LogOut, RefreshCw, Sparkles } from 'lucide-react';
import { api, ApiError } from './api';
import { Button, Dialog, Input } from './aspect/controls';
import { Assistant } from './components/Assistant';
import { Brand, Field, Notice } from './components/common';
import { EnrollmentDialog } from './components/EnrollmentDialog';
import { Fleet, NodeDetail, SignalArt } from './components/Fleet';
import type { FleetNode } from './domain';

type InstallEvent = Event & { prompt: () => Promise<unknown>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
type WorkspaceView = 'fleet' | 'assistant';

const syncTime = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

function Login({ onLogin }: { onLogin: () => void }) {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    const form = event.currentTarget;
    const password = String(new FormData(form).get('password') ?? '');
    busy.current = true;
    setLoading(true);
    setError('');
    try {
      const session = await api.login(password);
      if (session.authenticated) onLogin();
      else setError('Проверьте пароль владельца и повторите попытку.');
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 401 ? 'Неверный пароль.'
        : failure instanceof Error ? failure.message : 'Не удалось войти.');
    } finally {
      form.reset();
      busy.current = false;
      setLoading(false);
    }
  }

  return <main className="auth-shell">
    <div className="auth-layout"><div className="auth-form-card">
      <Brand />
      <span className="auth-lock"><LockKeyhole size={19} aria-hidden="true" /> Доступ владельца</span>
      <h1>Вход в Caudal</h1><p>Введите пароль, чтобы открыть панель инфраструктуры.</p>
      <form className="form-stack" onSubmit={event => void submit(event)}>
        <Field label="Пароль"><Input name="password" type="password" required maxLength={4096} autoComplete="current-password" /></Field>
        {error && <Notice>{error}</Notice>}
        <Button variant="primary" type="submit" disabled={loading}>{loading ? 'Входим…' : 'Войти'} <ArrowRight size={18} aria-hidden="true" /></Button>
      </form>
    </div><div className="auth-art" aria-hidden="true"><SignalArt /></div></div>
  </main>;
}

function useInstall() {
  const [prompt, setPrompt] = useState<InstallEvent>();
  const [installed, setInstalled] = useState(window.matchMedia('(display-mode: standalone)').matches);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const capture = (event: Event) => { event.preventDefault(); setPrompt(event as InstallEvent); };
    const complete = () => { setInstalled(true); setPrompt(undefined); };
    window.addEventListener('beforeinstallprompt', capture);
    window.addEventListener('appinstalled', complete);
    return () => {
      window.removeEventListener('beforeinstallprompt', capture);
      window.removeEventListener('appinstalled', complete);
    };
  }, []);

  async function install() {
    if (!prompt) { setHelp(true); return; }
    try {
      await prompt.prompt();
      if ((await prompt.userChoice).outcome === 'accepted') setInstalled(true);
    } catch {
      setHelp(true);
    } finally {
      setPrompt(undefined);
    }
  }
  return { installed, install, help, closeHelp: () => setHelp(false) };
}

function Workspace({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [nodes, setNodes] = useState<FleetNode[]>([]);
  const [ready, setReady] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number>();
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [view, setView] = useState<WorkspaceView>('fleet');
  const [editor, setEditor] = useState<'enroll' | FleetNode>();
  const load = useRef<AbortController | undefined>(undefined);
  const install = useInstall();
  const selected = nodes.find(node => node.id === selectedId);

  const refresh = useCallback(async () => {
    if (load.current) return;
    const controller = new AbortController();
    load.current = controller;
    setFetching(true);
    try {
      const result = await api.fleet(controller.signal);
      if (controller.signal.aborted) return;
      setNodes(result.nodes ?? []);
      setReady(true);
      setError('');
      setUpdatedAt(Date.now());
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) onUnauthorized();
      else setError(failure instanceof Error ? failure.message : 'Не удалось обновить парк.');
    } finally {
      if (load.current === controller) {
        load.current = undefined;
        setFetching(false);
      }
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      load.current?.abort();
      load.current = undefined;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  function move(nextView: WorkspaceView, focus = true) {
    setView(nextView);
    if (focus) requestAnimationFrame(() => document.getElementById(`${nextView}-heading`)?.focus());
  }

  function choose(id?: string) {
    setSelectedId(id);
    move('fleet');
  }

  function enrollNode(node: FleetNode) {
    load.current?.abort();
    load.current = undefined;
    setNodes(previous => [...previous.filter(existing => existing.id !== node.id), node]);
    setSelectedId(node.id);
    move('fleet', false);
    void refresh();
  }

  async function logout() {
    setSigningOut(true);
    setLogoutError('');
    try {
      await api.logout();
      onUnauthorized();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onUnauthorized();
      else setLogoutError(failure instanceof Error ? failure.message : 'Не удалось завершить сеанс.');
    } finally {
      setSigningOut(false);
    }
  }

  return <div className="app-shell" data-current-view={view}>
    <a className="skip-link" href="#workspace">К содержимому</a>
    <aside className="sidebar">
      <Brand />
      <nav aria-label="Рабочая область" className="sidebar-nav">
        <Button variant="ghost" className="nav-item" aria-current={view === 'fleet' ? 'page' : undefined} onClick={() => choose()}><LayoutGrid size={18} aria-hidden="true" /> Парк</Button>
        <Button variant="ghost" className="nav-item" aria-current={view === 'assistant' ? 'page' : undefined} onClick={() => move('assistant')}><Sparkles size={18} aria-hidden="true" /> Ассистент</Button>
      </nav>
      {!install.installed && <Button variant="ghost" className="nav-item install-button" onClick={() => void install.install()} aria-haspopup="dialog">
        <Download size={18} aria-hidden="true" /> Установить Caudal
      </Button>}
    </aside>
    <div className="workspace-shell">
      <header className="workspace-header">
        <span className="workspace-title">Инфраструктура</span>
        <div className="header-actions">
          {updatedAt && <span className="sync-time" title="Последнее обновление списка">Обновлено в {syncTime.format(updatedAt)} UTC</span>}
          <Button variant="ghost" className="icon-button refresh-button" onClick={() => void refresh()} disabled={fetching} aria-label="Обновить парк" title="Обновить парк"><RefreshCw size={17} aria-hidden="true" /></Button>
          <span className="header-divider" />
          <Button variant="ghost" className="logout-button" onClick={() => void logout()} disabled={signingOut} aria-label="Выйти" title="Выйти"><LogOut size={17} aria-hidden="true" /><span>Выйти</span></Button>
        </div>
      </header>
      <main className="workspace" id="workspace" tabIndex={-1}>
        {logoutError && <Notice>{logoutError}</Notice>}
        {selected && error && <Notice>{error} Показаны последние доступные данные. <Button variant="ghost" onClick={() => void refresh()}>Повторить</Button></Notice>}
        <div className="workspace-grid">
          <div className="fleet-slot">
            {selected ? <NodeDetail key={selected.id} node={selected} goBack={() => choose()} onUnauthorized={onUnauthorized} onRotate={() => setEditor(selected)} snapshot={Boolean(error)} />
              : <Fleet nodes={nodes} ready={ready} error={error} onChoose={choose} onEnroll={() => setEditor('enroll')} onRetry={() => void refresh()} />}
          </div>
          <aside className="assistant-slot">
            <Assistant nodes={nodes} selected={selected} onChoose={choose} onUnauthorized={onUnauthorized} />
          </aside>
        </div>
      </main>
    </div>
    {editor && <EnrollmentDialog onClose={() => setEditor(undefined)} onCreated={enrollNode} onUnauthorized={onUnauthorized} rotateNode={editor === 'enroll' ? undefined : editor} />}
    {install.help && <Dialog open title="Установить Caudal" closeLabel="Закрыть подсказку" onClose={install.closeHelp}>
      <div className="install-help"><p>В меню браузера выберите «Установить приложение» или «На экран Домой». В Safari на iPhone эта команда доступна в меню «Поделиться».</p>
        <div className="dialog-actions"><Button onClick={install.closeHelp}>Закрыть</Button></div></div>
    </Dialog>}
  </div>;
}

export function App() {
  const [auth, setAuth] = useState<'loading' | 'ready' | 'visiting' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api.session(controller.signal).then(session => setAuth(session.authenticated ? 'ready' : 'visiting')).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) setAuth('visiting');
      else {
        setMessage(error instanceof Error ? error.message : 'Не удалось проверить сеанс.');
        setAuth('error');
      }
    });
    return () => controller.abort();
  }, [attempt]);
  const onUnauthorized = useCallback(() => setAuth('visiting'), []);

  if (auth === 'ready') return <Workspace onUnauthorized={onUnauthorized} />;
  if (auth === 'visiting') return <Login onLogin={() => setAuth('ready')} />;
  return <main className="auth-shell"><div className="session-card"><Brand />
    {auth === 'error' ? <><Notice>{message}</Notice><Button onClick={() => { setAuth('loading'); setAttempt(old => old + 1); }}>Повторить</Button></>
      : <p role="status">Проверяем сеанс…</p>}
  </div></main>;
}

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, LayoutGrid, LockKeyhole, Route, Settings2, Sparkles } from 'lucide-react';
import { api, ApiError } from './api';
import { Button, Dialog, Input } from './aspect/controls';
import { Assistant } from './components/Assistant';
import { Brand, Field, Notice } from './components/common';
import { EnrollmentDialog } from './components/EnrollmentDialog';
import { Fleet, NodeDetail } from './components/Fleet';
import { Compare } from './components/Compare';
import { FlowArt } from './components/FlowArt';
import { Guide } from './components/Guide';
import { ModeSwitch, Settings, SyncIndicator } from './components/Settings';
import { useFleetSync } from './fleetSync';
import { usePreferences, type Layout, type Preferences } from './preferences';
import type { Architecture, FleetNode } from './domain';

type InstallEvent = Event & { prompt: () => Promise<unknown>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
type WorkspaceView = 'fleet' | 'assistant' | 'guide' | 'settings';
type NodeEditor = { node?: FleetNode; architecture?: Architecture };

const navigation = [
  { id: 'fleet', label: 'Парк', icon: LayoutGrid },
  { id: 'assistant', label: 'Ассистент', icon: Sparkles },
  { id: 'guide', label: 'Маршруты', icon: Route },
  { id: 'settings', label: 'Настройки', icon: Settings2 },
] as const;

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
    </div><div className="auth-art" aria-hidden="true"><FlowArt /></div></div>
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

function Workspace({ onUnauthorized, preferences, update }: {
  onUnauthorized: () => void;
  preferences: Preferences;
  update: (patch: Partial<Preferences>) => void;
}) {
  const sync = useFleetSync(preferences, onUnauthorized);
  const [logoutError, setLogoutError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [view, setView] = useState<WorkspaceView>('fleet');
  const [showList, setShowList] = useState(false);
  const [editor, setEditor] = useState<NodeEditor>();
  const install = useInstall();
  const selected = sync.nodes.find(node => node.id === selectedId);
  const layout = preferences.layout;
  const showCompare = layout === 'multi' && !selected && !showList && sync.ready;
  const agentFocused = layout === 'agent' && !selected && !showList;
  const workspaceVisible = view === 'fleet' || view === 'assistant';
  const showAssistant = view === 'assistant' || (view === 'fleet' && (layout === 'overview' || agentFocused));
  const split = view === 'fleet' && layout === 'overview';

  function focus(heading: string) {
    requestAnimationFrame(() => document.getElementById(`${heading}-heading`)?.focus());
  }

  function move(nextView: WorkspaceView) {
    setView(nextView);
    focus(nextView);
  }

  function choose(id?: string) {
    setSelectedId(id);
    setShowList(false);
    if (id || layout !== 'agent') move('fleet');
    else {
      setView('fleet');
      focus('assistant');
    }
  }

  function showFleet() {
    setSelectedId(undefined);
    setShowList(true);
    move('fleet');
  }

  function changeMode(next: Layout) {
    update({ layout: next });
    setSelectedId(undefined);
    setShowList(false);
    setView('fleet');
  }

  function enroll(architecture?: Architecture) {
    setEditor({ architecture });
  }

  function acceptNode(node: FleetNode) {
    sync.accept(node);
    setSelectedId(node.id);
    if (view !== 'guide') setView('fleet');
  }

  function closeEditor() {
    setEditor(undefined);
    if (view === 'fleet' && selected && !editor?.node) focus('fleet');
  }

  async function logout() {
    if (signingOut) return;
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

  return <div className="app-shell" data-current-view={view} data-layout={layout} data-density={preferences.density}>
    <a className="skip-link" href="#workspace">К содержимому</a>
    <aside className="sidebar">
      <Brand />
      <nav aria-label="Рабочая область" className="sidebar-nav">
        {navigation.map(({ id, label, icon: Icon }) => <Button variant="ghost" className="nav-item" key={id} aria-current={view === id ? 'page' : undefined}
          onClick={() => { if (id === 'fleet') choose(); else move(id); }}><Icon size={18} aria-hidden="true" /><span>{label}</span></Button>)}
      </nav>
    </aside>
    <div className="workspace-shell">
      <header className="workspace-header">
        <span className="workspace-title">Инфраструктура</span>
        <SyncIndicator status={sync.status} updatedAt={sync.updatedAt} announce />
      </header>
      <main className="workspace" id="workspace" tabIndex={-1}>
        {workspaceVisible && <ModeSwitch mode={layout} onChange={changeMode} />}
        {workspaceVisible && sync.error && (selected || showCompare || view === 'assistant' || agentFocused) && <Notice>{sync.error}
          {sync.ready && ' Показаны последние доступные данные.'} <Button variant="ghost" onClick={() => void sync.refresh()}>Повторить</Button></Notice>}
        <div className="workspace-grid" data-split={split} hidden={!workspaceVisible}>
          <div className="fleet-slot" hidden={view !== 'fleet' || agentFocused}>
            {selected ? <NodeDetail key={selected.id} node={selected} goBack={() => choose()} onUnauthorized={onUnauthorized} onRotate={() => setEditor({ node: selected })} snapshot={Boolean(sync.error)} />
              : showCompare ? <Compare nodes={sync.nodes} onChoose={choose} onFleet={showFleet} snapshot={Boolean(sync.error)} />
              : <Fleet nodes={sync.nodes} ready={sync.ready} error={sync.error} onChoose={choose} onEnroll={enroll} onGuide={() => move('guide')} onRetry={() => void sync.refresh()} telemetry={layout === 'sre'} />}
          </div>
          <aside className="assistant-slot" hidden={!showAssistant}>
            <Assistant nodes={sync.nodes} selected={selected} onChoose={choose} onUnauthorized={onUnauthorized} />
          </aside>
        </div>
        {view === 'guide' && <Guide nodes={sync.nodes} controlPlaneNodeId={sync.controlPlaneNodeId} onEnroll={enroll} onChoose={choose} onAssistant={() => move('assistant')} onUnauthorized={onUnauthorized} />}
        {view === 'settings' && <Settings preferences={preferences} update={update} status={sync.status} updatedAt={sync.updatedAt} onRecover={() => void sync.refresh()}
          fetching={sync.fetching} onLogout={() => void logout()} signingOut={signingOut} logoutError={logoutError} onInstall={install.installed ? undefined : () => void install.install()} />}
      </main>
    </div>
    {editor && <EnrollmentDialog onClose={closeEditor} onCreated={acceptNode} onUnauthorized={onUnauthorized} rotateNode={editor.node} initialArchitecture={editor.architecture}
      finishLabel={view === 'guide' ? 'Вернуться к маршруту' : undefined} />}
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
  const { preferences, update } = usePreferences();
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

  if (auth === 'ready') return <Workspace onUnauthorized={onUnauthorized} preferences={preferences} update={update} />;
  if (auth === 'visiting') return <Login onLogin={() => setAuth('ready')} />;
  return <main className="auth-shell"><div className="session-card"><Brand />
    {auth === 'error' ? <><Notice>{message}</Notice><Button onClick={() => { setAuth('loading'); setAttempt(old => old + 1); }}>Повторить</Button></>
      : <p role="status">Проверяем сеанс…</p>}
  </div></main>;
}

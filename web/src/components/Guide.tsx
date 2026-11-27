import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Clock3, ExternalLink, List, Network, Radio, Server, Sparkles } from 'lucide-react';
import { api, ApiError } from '../api';
import { Badge, Button } from '../aspect/controls';
import { formatBytes, formatPercent, recentSamples, type Architecture, type FleetNode, type NodeStatus, type OperationSummary, type Sample, type TeleportProfile } from '../domain';
import { Field, Notice, Observation, Status } from './common';
import './guide.css';

type GuideProps = {
  nodes: FleetNode[];
  controlPlaneNodeId?: string;
  onEnroll: (architecture?: Architecture) => void;
  onChoose: (id: string) => void;
  onAssistant: () => void;
  onUnauthorized: () => void;
};

type ConnectionTab = 'operations' | 'signals' | 'history' | 'collector';
const connectionTabs = [
  { id: 'operations', name: 'Операции', icon: List },
  { id: 'signals', name: 'Сравнение сигналов', icon: Network },
  { id: 'history', name: 'История', icon: Clock3 },
  { id: 'collector', name: 'Сборщик', icon: Radio },
] as const;

function useAction<T>(onUnauthorized: () => void) {
  const [result, setResult] = useState<T>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => {
    active.current?.abort();
    active.current = null;
  }, []);

  const run = useCallback(async (action: (signal: AbortSignal) => Promise<T>) => {
    if (active.current) return;
    const request = new AbortController();
    active.current = request;
    setPending(true);
    setError('');
    setResult(undefined);
    try {
      const response = await action(request.signal);
      if (!request.signal.aborted) setResult(response);
    } catch (failure) {
      if (request.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) onUnauthorized();
      else setError(failure instanceof Error ? failure.message : 'Не удалось выполнить проверку.');
    } finally {
      if (active.current === request) {
        active.current = null;
        setPending(false);
      }
    }
  }, [onUnauthorized]);

  function clear() {
    setResult(undefined);
    setError('');
  }

  return { result, error, pending, run, clear };
}

function firstSignal(nodes: FleetNode[]) {
  return nodes.reduce<FleetNode | undefined>((latest, node) =>
    !latest || Date.parse(node.created_at) >= Date.parse(latest.created_at) ? node : latest, undefined);
}

function signalStatus(observedAt: string | undefined, now: number): NodeStatus {
  if (!observedAt) return 'pending';
  const age = now - Date.parse(observedAt);
  return Number.isFinite(age) && age >= -5_000 && age < 90_000 ? 'healthy' : 'stale';
}

function CollectorSetup({ nodes, onEnroll, onChoose }: Pick<GuideProps, 'nodes' | 'onEnroll' | 'onChoose'>) {
  const [architecture, setArchitecture] = useState<Architecture>('amd64');
  const node = firstSignal(nodes);

  return <div className="guide-pair">
    <div className="guide-task">
      <h3>Сборщик для Linux</h3>
      <p>Узнайте архитектуру сервера командой <code>uname -m</code>.</p>
      <Field label="Архитектура Linux">
        <select className="aspect-input" value={architecture} onChange={event => setArchitecture(event.target.value as Architecture)}>
          <option value="amd64">x86_64 (amd64)</option>
          <option value="arm64">aarch64 (arm64)</option>
        </select>
      </Field>
      <Button variant="primary" aria-haspopup="dialog" onClick={() => onEnroll(architecture)}>Подключить узел <ArrowRight size={16} aria-hidden="true" /></Button>
    </div>
    <div className="guide-receipt guide-first-receipt" aria-live="polite">
      <span className="guide-receipt-icon"><Radio size={20} aria-hidden="true" /></span>
      <h3>Последний добавленный узел</h3>
      {node ? <>
        <strong>{node.name}</strong><Status status={node.status} />
        {node.last_seen ? <Observation value={node.last_seen} /> : <p>Запустите сборщик. Первый сигнал появится после обновления парка.</p>}
        <Button variant="ghost" onClick={() => onChoose(node.id)}>Открыть узел</Button>
      </> : <p>После регистрации узла здесь появится его состояние.</p>}
    </div>
  </div>;
}

function NodeSelect({ label, nodes, value, onChange, disabled }: {
  label: string;
  nodes: FleetNode[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  return <Field label={label}>
    <select className="aspect-input" value={value} onChange={event => onChange(event.target.value)} disabled={disabled}>
      {nodes.length === 0 && <option value="">Нет доступных узлов</option>}
      {nodes.map(node => <option value={node.id} key={node.id}>{node.name}{node.region ? ` · ${node.region}` : ''}</option>)}
    </select>
  </Field>;
}

function HistoryPanel({ nodes, onChoose, onAssistant, onUnauthorized }: Pick<GuideProps, 'nodes' | 'onChoose' | 'onAssistant' | 'onUnauthorized'>) {
  const [selectedId, setSelectedId] = useState('');
  const selected = nodes.find(node => node.id === selectedId) ?? nodes[0];
  const check = useAction<Sample[]>(onUnauthorized);
  const latest = check.result && recentSamples(check.result, 1)[0];

  return <>
    <div className="guide-pair">
      <div className="guide-task">
        <h3>Прочитайте историю узла</h3>
        <p>Запрос вернёт сохранённые измерения и время их получения.</p>
        <NodeSelect label="Узел для диагностики" nodes={nodes} value={selected?.id ?? ''} disabled={check.pending}
          onChange={id => { setSelectedId(id); check.clear(); }} />
        <Button variant="primary" disabled={!selected || check.pending} onClick={() => {
          if (selected) void check.run(async signal => (await api.samples(selected.id, signal)).samples);
        }}>{check.pending ? 'Читаем историю…' : 'Прочитать историю'}<ArrowRight size={16} aria-hidden="true" /></Button>
        {check.error && <Notice>{check.error}</Notice>}
      </div>
      <div className="guide-receipt" aria-live="polite">
        <span className="guide-receipt-icon"><Clock3 size={20} aria-hidden="true" /></span>
        <h3>Результат чтения</h3>
        {latest ? <>
          <strong>История загружена · {check.result?.length}</strong>
          <Observation value={latest.observed_at} />
          <dl className="guide-history-data"><div><dt>CPU</dt><dd>{formatPercent(latest.metrics.cpu_percent)}</dd></div>
            <div><dt>Память</dt><dd>{formatBytes(latest.metrics.memory_used_bytes)}</dd></div></dl>
        </> : <p>{check.result ? 'Сборщик пока не отправил измерения.' : 'Здесь появятся время последнего сигнала, CPU и память.'}</p>}
      </div>
    </div>
    {check.result && selected && <div className="guide-footer">
      <Button variant="secondary" onClick={() => { onChoose(selected.id); onAssistant(); }}>
        <Sparkles size={16} aria-hidden="true" /> Спросить ассистента об узле
      </Button>
    </div>}
  </>;
}

type RouteReceipt = { node: FleetNode; sample?: Sample; error?: string; status: NodeStatus };

async function checkSignals(source: FleetNode, destination: FleetNode, signal: AbortSignal): Promise<RouteReceipt[]> {
  const nodes = [source, destination];
  const data = await Promise.allSettled(nodes.map(async node => (await api.samples(node.id, signal)).samples));
  const now = Date.now();
  return data.map((response, index) => {
    const node = nodes[index];
    if (response.status === 'rejected') {
      if (response.reason instanceof ApiError && response.reason.status === 401) throw response.reason;
      return { node, error: response.reason instanceof Error ? response.reason.message : 'Не удалось прочитать измерения.', status: 'pending' };
    }
    const sample = recentSamples(response.value, 1)[0];
    return { node, sample, status: signalStatus(sample?.observed_at, now) };
  });
}

function SignalComparison({ nodes, controlPlaneNodeId, onUnauthorized }: Pick<GuideProps, 'nodes' | 'controlPlaneNodeId' | 'onUnauthorized'>) {
  const [sourceId, setSource] = useState('');
  const [destinationId, setDestination] = useState('');
  const source = nodes.find(node => node.id === sourceId) ?? nodes[0];
  const destinations = nodes.filter(node => node.id !== source?.id);
  const destination = destinations.find(node => node.id === destinationId) ?? destinations[0];
  const check = useAction<RouteReceipt[]>(onUnauthorized);
  const directed = Boolean(controlPlaneNodeId) && destination?.id === controlPlaneNodeId;
  const sourceReceipt = check.result?.[0];
  const destinationReceipt = check.result?.[1];

  return <>
    <div className="guide-task guide-route-task">
      <h3>Сверьте два источника</h3>
      <p>Прочитайте последние сигналы двух узлов. Каждый сборщик передаёт отчёт по HTTPS в Caudal.</p>
      <div className="guide-node-selects">
        <NodeSelect label="Источник" nodes={nodes} value={source?.id ?? ''} disabled={check.pending}
          onChange={id => { setSource(id); check.clear(); }} />
        <NodeSelect label="Второй узел" nodes={destinations} value={destination?.id ?? ''} disabled={check.pending}
          onChange={id => { setDestination(id); check.clear(); }} />
      </div>
      {!destination && <p>Для сравнения подключите два разных узла.</p>}
      <Button variant="primary" disabled={!source || !destination || check.pending} onClick={() => {
        if (source && destination) void check.run(signal => checkSignals(source, destination, signal));
      }}>{check.pending ? 'Сверяем сигналы…' : 'Сверить сигналы двух узлов'}<ArrowRight size={16} aria-hidden="true" /></Button>
      {check.error && <Notice>{check.error}</Notice>}
    </div>
    <div className="guide-route-results" aria-live="polite">
      {sourceReceipt && destinationReceipt && <>
        <div className="guide-pair">
          {check.result?.map(({ node, sample, status, error }) => <div className="guide-receipt" key={node.id}>
            <span className="guide-receipt-icon"><Server size={20} aria-hidden="true" /></span>
            <h3>{node.name}</h3>
            {error ? <Notice>{error}</Notice> : <><Status status={status} snapshot={status === 'healthy'} /><Observation value={sample?.observed_at} /></>}
          </div>)}
        </div>
        {directed && sourceReceipt.status === 'healthy' && sourceReceipt.sample ? <div className="guide-path-confirmed">
          <span><Radio size={17} aria-hidden="true" /><strong>{sourceReceipt.node.name} → Caudal на {destinationReceipt.node.name}</strong></span>
          <p>Сборщик доставил отчёт по HTTPS. <Observation value={sourceReceipt.sample.observed_at} /></p>
        </div> : directed ? <p className="guide-route-note">Для подтверждения пути к Caudal нужен свежий сигнал с узла-источника.</p> :
          <p className="guide-route-note">Это два отдельных соединения с Caudal. Связь между выбранными узлами остаётся неизвестной.</p>}
      </>}
    </div>
    <details className="guide-explainer">
      <summary>Как устроен SSH через промежуточный узел</summary>
      <p>Ваше устройство → разрешённый SSH-шлюз → целевой VPS. Для проверки нужны права на оба хоста и доверенные ключи хостов. Сигналы сборщика подтверждают доставку по HTTPS. Состояние SSH проверяется отдельно.</p>
    </details>
  </>;
}

const teleportProblems: Record<string, string> = {
  dns_error: 'Caudal не получил адрес прокси через DNS.',
  tls_certificate: 'Caudal не смог проверить сертификат TLS. Сверьте имя прокси и цепочку доверия.',
  timeout: 'Прокси не успел ответить из сети Caudal.',
  network_error: 'Caudal не смог установить соединение с прокси.',
  non_public_address: 'Прокси разрешается в адрес, закрытый для этой проверки.',
  http_denied: 'По HTTPS пришёл ответ, но прокси отклонил запрос проверки.',
  redirect: 'Прокси перенаправил запрос. Проверьте основной адрес веб-прокси.',
  http_error: 'Прокси ответил с ошибкой HTTP.',
  unexpected_response: 'Прокси ответил, но формат ответа Teleport не распознан.',
};

function httpsLink(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* An invalid profile address stays as text. */ }
}

function TeleportProfiles({ onUnauthorized }: { onUnauthorized: () => void }) {
  const list = useAction<TeleportProfile[]>(onUnauthorized);
  const verification = useAction<TeleportProfile>(onUnauthorized);
  const [observed, setObserved] = useState<Record<string, TeleportProfile>>({});
  const load = list.run;
  const latest = verification.result;

  useEffect(() => {
    void load(async signal => (await api.teleport(signal)).profiles);
  }, [load]);

  async function verify(profile: TeleportProfile) {
    await verification.run(async signal => {
      const checked = (await api.checkTeleport(profile.id, signal)).profile;
      if (!signal.aborted) setObserved(previous => ({ ...previous, [checked.id]: checked }));
      return checked;
    });
  }

  return <section className="guide-teleport" aria-labelledby="guide-teleport-heading">
    <div className="guide-teleport-heading" data-tour="connections-teleport"><Network size={18} aria-hidden="true" /><h3 id="guide-teleport-heading">Веб-прокси Teleport</h3></div>
    <p>Caudal проверяет веб-прокси из своей сети. Вход, права и доступ к целевому хосту проверяются в Teleport.</p>
    {list.pending && <p role="status">Загружаем прокси…</p>}
    {list.error && <Notice>{list.error} <Button variant="ghost" onClick={() => void load(async signal => (await api.teleport(signal)).profiles)}>Повторить загрузку</Button></Notice>}
    {list.result?.length === 0 && <p>В Caudal пока нет настроенных прокси Teleport.</p>}
    {list.result?.map(configured => {
      const profile = observed[configured.id] ?? configured;
      const link = httpsLink(profile.web_url);
      const status = profile.status === 'reachable' ? 'Прокси отвечает' : profile.status === 'unreachable' ? 'Проверка не прошла' : 'Ожидает проверки';
      const problem = profile.error && Object.hasOwn(teleportProblems, profile.error) ? teleportProblems[profile.error] : 'Проверьте адрес, доступность сети и TLS.';
      return <div className="guide-teleport-row" key={profile.id}>
        <div className="guide-teleport-meta">
          <strong>{profile.label}</strong>
          <span>{profile.web_url}</span>
          <div className="guide-teleport-status" aria-live="polite">
            <Badge tone={profile.status === 'reachable' ? 'success' : profile.status === 'unreachable' ? 'warning' : 'neutral'}>{status}</Badge>
            {profile.checked_at && <Observation value={profile.checked_at} />}
            {profile.latency_ms !== undefined && <span>{profile.latency_ms} мс</span>}
            {profile.version && <span>Teleport {profile.version}</span>}
          </div>
          {profile.status === 'unreachable' && <p className="guide-route-note">{problem}</p>}
        </div>
        <div className="guide-teleport-actions">
          <Button disabled={verification.pending} onClick={() => void verify(profile)}>
            {verification.pending ? 'Проверяем…' : 'Проверить прокси'}
          </Button>
          {link && <a href={link} target="_blank" rel="noreferrer noopener" title="Откроется в новой вкладке">Открыть Teleport <ExternalLink size={14} aria-hidden="true" /></a>}
        </div>
      </div>;
    })}
    {verification.error && <Notice>{verification.error}</Notice>}
    <span className="sr-only" role="status">{latest ? `Проверка ${latest.label} завершена.` : ''}</span>
  </section>;
}

const transports: Record<OperationSummary['transport'], string> = { fleet: 'Метрики', ssh: 'SSH', tsh: 'TSH', http: 'HTTP', teleport: 'Teleport' };
const effects: Record<OperationSummary['effect'], string> = { read: 'Чтение', change: 'Изменение', destructive: 'Разрушающее действие' };

function Catalog({ onUnauthorized }: { onUnauthorized: () => void }) {
  const catalog = useAction<OperationSummary[]>(onUnauthorized);
  const load = catalog.run;
  useEffect(() => {
    void load(async signal => (await api.operations(signal)).operations);
  }, [load]);

  return <section className="operation-catalog" aria-labelledby="connections-catalog-heading">
    <h3 id="connections-catalog-heading" data-tour="connections-catalog">Разрешённые операции</h3>
    <p>Доступные операции и цели из конфигурации Caudal. Запуски доступны в ассистенте.</p>
    {catalog.pending && <p role="status">Загружаем операции…</p>}
    {catalog.error && <Notice>{catalog.error} <Button variant="ghost" onClick={() => void load(async signal => (await api.operations(signal)).operations)}>Повторить загрузку</Button></Notice>}
    {catalog.result?.length === 0 && <p>В Caudal пока нет настроенных операций.</p>}
    {Boolean(catalog.result?.length) && <ul className="operations-list">
      {catalog.result?.map(operation => <li key={operation.id}>
        <div><strong>{operation.label}</strong><span>{operation.target}{operation.method ? ` · ${operation.method}` : ''}</span></div>
        <div className="operation-labels"><Badge>{transports[operation.transport]}</Badge>
          <Badge tone={operation.effect === 'read' ? 'neutral' : 'warning'}>{effects[operation.effect]}</Badge></div>
      </li>)}
    </ul>}
  </section>;
}

export function Guide({ nodes, controlPlaneNodeId, onEnroll, onChoose, onAssistant, onUnauthorized }: GuideProps) {
  const [tab, setTab] = useState<ConnectionTab>('operations');
  const heading = useRef<HTMLHeadingElement>(null);
  const title = tab === 'operations' ? 'Каталог подключений' : tab === 'signals' ? 'Доставка сигналов' : tab === 'history' ? 'История измерений' : 'Подключение сборщика';

  function selectTab(next: ConnectionTab) {
    if (tab === next) return;
    setTab(next);
    requestAnimationFrame(() => heading.current?.focus());
  }

  return <section className="guide" aria-labelledby="guide-heading">
    <div className="view-heading guide-heading"><div>
      <h1 id="guide-heading" tabIndex={-1}>Подключения</h1><p>Операции, веб-прокси и измерения из вашей инфраструктуры.</p>
    </div></div>
    <div className="connection-tabs" role="group" aria-label="Виды подключения" data-tour="connections-tabs">
      {connectionTabs.map(({ id, name, icon: Icon }) => <Button key={id} variant="ghost" aria-pressed={id === tab} onClick={() => selectTab(id)}>
        <Icon size={17} aria-hidden="true" /> {name}
      </Button>)}
    </div>
    <section className="guide-panel panel" aria-labelledby="guide-tab-heading">
      <div className="panel-heading"><h2 ref={heading} id="guide-tab-heading" tabIndex={-1}>{title}</h2></div>
      <div className="guide-panel-body" key={tab}>
        {tab === 'operations' && <><Catalog onUnauthorized={onUnauthorized} /><TeleportProfiles onUnauthorized={onUnauthorized} /></>}
        {tab === 'signals' && <SignalComparison nodes={nodes} controlPlaneNodeId={controlPlaneNodeId} onUnauthorized={onUnauthorized} />}
        {tab === 'history' && <HistoryPanel nodes={nodes} onChoose={onChoose} onAssistant={onAssistant} onUnauthorized={onUnauthorized} />}
        {tab === 'collector' && <CollectorSetup nodes={nodes} onEnroll={onEnroll} onChoose={onChoose} />}
      </div>
    </section>
  </section>;
}

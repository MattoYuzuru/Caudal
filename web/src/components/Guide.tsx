import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Clock3, ExternalLink, Network, Radio, Server, Sparkles } from 'lucide-react';
import { api, ApiError } from '../api';
import { Badge, Button } from '../aspect/controls';
import { formatBytes, formatPercent, recentSamples, type Architecture, type FleetNode, type NodeStatus, type Sample, type TeleportProfile } from '../domain';
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

type Step = 'first' | 'history' | 'routes';
const steps = [
  { id: 'first', name: 'Первый узел', icon: Radio },
  { id: 'history', name: 'Диагностика', icon: Clock3 },
  { id: 'routes', name: 'Несколько VPS', icon: Network },
] as const;
const sampleMetrics = {
  cpu_percent: 13.4, memory_used_bytes: 1_529_495_552, memory_total_bytes: 4_294_967_296,
  disk_used_bytes: 16_106_127_360, disk_total_bytes: 64_424_509_440, uptime_seconds: 196_807,
};

function trainingNodes(): FleetNode[] {
  const now = Date.now();
  const created_at = new Date(now - 86_400_000).toISOString();
  return [
    { id: 'lab-north', name: 'Север', region: 'Хельсинки', created_at, status: 'healthy',
      last_seen: new Date(now - 14000).toISOString(), metrics: sampleMetrics },
    { id: 'lab-east', name: 'Восток', region: 'Варшава', created_at, status: 'stale',
      last_seen: new Date(now - 162000).toISOString(), metrics: { ...sampleMetrics, cpu_percent: 28.9 } },
  ];
}

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

function FirstStep({ nodes, training, onEnroll, onChoose, onNext }: Pick<GuideProps, 'nodes' | 'onEnroll' | 'onChoose'> & {
  training: boolean;
  onNext: () => void;
}) {
  const [architecture, setArchitecture] = useState<Architecture>('amd64');
  const [sample, setSample] = useState<FleetNode>();
  const node = training ? sample : firstSignal(nodes);
  const hasSignal = Boolean(node?.last_seen);
  const status = node?.status === 'healthy' ? signalStatus(node.last_seen, Date.now()) : node?.status;

  return <>
    <div className="guide-pair">
      <div className="guide-task">
        <h3>Подключите сборщик</h3>
        <p>Узнайте архитектуру на своём Linux-сервере командой <code>uname -m</code>.</p>
        <Field label="Архитектура Linux">
          <select className="aspect-input" value={architecture} onChange={event => setArchitecture(event.target.value as Architecture)}>
            <option value="amd64">x86_64 (amd64)</option>
            <option value="arm64">aarch64 (arm64)</option>
          </select>
        </Field>
        <Button variant="primary" aria-haspopup={training ? undefined : 'dialog'} onClick={() => {
          if (training) setSample(trainingNodes()[0]);
          else onEnroll(architecture);
        }}>{training ? 'Получить учебный сигнал' : 'Подключить узел'}<ArrowRight size={16} aria-hidden="true" /></Button>
      </div>
      <div className="guide-receipt guide-first-receipt" aria-live="polite">
        <span className="guide-receipt-icon"><Radio size={20} aria-hidden="true" /></span>
        <h3>{training ? 'Учебный сигнал' : 'Последний добавленный узел'}</h3>
        {node ? <>
          <strong>{node.name}</strong>
          <Status status={status ?? 'pending'} />
          {hasSignal ? <Observation value={node.last_seen} /> : <p>Запустите сборщик. Первый сигнал появится здесь после обновления парка.</p>}
          {!training && <Button variant="ghost" onClick={() => onChoose(node.id)}>Открыть узел</Button>}
        </> : <p>{training ? 'Нажмите кнопку, чтобы увидеть пример отчёта сборщика.' : 'После добавления узла здесь появится время первого сигнала.'}</p>}
      </div>
    </div>
    {hasSignal && <div className="guide-footer"><Button onClick={onNext}>Перейти к диагностике <ArrowRight size={15} aria-hidden="true" /></Button></div>}
  </>;
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

function trainingSamples(node: FleetNode): Sample[] {
  if (!node.metrics || !node.last_seen) return [];
  const earlier = new Date(Date.parse(node.last_seen) - 30_000).toISOString();
  return [{ observed_at: earlier, metrics: { ...node.metrics, cpu_percent: 7.1 } }, { observed_at: node.last_seen, metrics: node.metrics }];
}

async function readSamples(node: FleetNode, training: boolean, signal: AbortSignal) {
  return training ? trainingSamples(node) : (await api.samples(node.id, signal)).samples;
}

function HistoryStep({ nodes, training, onChoose, onAssistant, onUnauthorized, onNext }:
  Pick<GuideProps, 'nodes' | 'onChoose' | 'onAssistant' | 'onUnauthorized'> & { training: boolean; onNext: () => void }) {
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
          if (selected) void check.run(signal => readSamples(selected, training, signal));
        }}>{check.pending ? 'Читаем историю…' : 'Прочитать историю'}<ArrowRight size={16} aria-hidden="true" /></Button>
        {check.error && <Notice>{check.error}</Notice>}
      </div>
      <div className="guide-receipt" aria-live="polite">
        <span className="guide-receipt-icon"><Clock3 size={20} aria-hidden="true" /></span>
        <h3>{training ? 'Учебная история' : 'Результат чтения'}</h3>
        {latest ? <>
          <strong>История загружена · {check.result?.length}</strong>
          <Observation value={latest.observed_at} />
          <dl className="guide-history-data"><div><dt>CPU</dt><dd>{formatPercent(latest.metrics.cpu_percent)}</dd></div>
            <div><dt>Память</dt><dd>{formatBytes(latest.metrics.memory_used_bytes)}</dd></div></dl>
        </> : <p>{check.result ? 'Сборщик пока не отправил измерения.' : 'Здесь появятся время последнего сигнала, CPU и память.'}</p>}
      </div>
    </div>
    {check.result && <div className="guide-footer">
      {selected && !training && <Button variant="secondary" onClick={() => { onChoose(selected.id); onAssistant(); }}>
        <Sparkles size={16} aria-hidden="true" />Спросить ассистента об узле
      </Button>}
      {training && latest && <p className="guide-suggestion">Попробуйте спросить «Какие данные по памяти есть у этого узла?»</p>}
      <Button onClick={onNext}>Проверить два узла <ArrowRight size={15} aria-hidden="true" /></Button>
    </div>}
  </>;
}

type RouteReceipt = { node: FleetNode; sample?: Sample; error?: string; status: NodeStatus };

async function checkSignals(source: FleetNode, destination: FleetNode, training: boolean, signal: AbortSignal): Promise<RouteReceipt[]> {
  const nodes = [source, destination];
  const data = await Promise.allSettled(nodes.map(node => readSamples(node, training, signal)));
  const now = Date.now();
  return data.map((response, index) => {
    const node = nodes[index];
    if (response.status === 'rejected') {
      if (response.reason instanceof ApiError && response.reason.status === 401) throw response.reason;
      return { node, error: response.reason instanceof Error ? response.reason.message : 'Не удалось прочитать измерения.', status: 'pending' };
    }
    const sample = recentSamples(response.value, 1)[0];
    return { node, sample, status: training ? node.status : signalStatus(sample?.observed_at, now) };
  });
}

function RouteStep({ nodes, training, controlPlaneNodeId, onUnauthorized }: Pick<GuideProps, 'nodes' | 'controlPlaneNodeId' | 'onUnauthorized'> & { training: boolean }) {
  const [sourceId, setSource] = useState('');
  const [destinationId, setDestination] = useState('');
  const source = nodes.find(node => node.id === sourceId) ?? nodes[0];
  const destinations = nodes.filter(node => node.id !== source?.id);
  const destination = destinations.find(node => node.id === destinationId) ?? destinations[0];
  const check = useAction<RouteReceipt[]>(onUnauthorized);
  const directed = !training && Boolean(controlPlaneNodeId) && destination?.id === controlPlaneNodeId;
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
        if (source && destination) void check.run(signal => checkSignals(source, destination, training, signal));
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
    <TeleportStep training={training} onUnauthorized={onUnauthorized} />
  </>;
}

const exampleTeleport: TeleportProfile = { id: 'lab-proxy', label: 'Учебный прокси', web_url: 'https://teleport.example.invalid', status: 'not_checked' };
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

function TeleportStep({ training, onUnauthorized }: { training: boolean; onUnauthorized: () => void }) {
  const list = useAction<TeleportProfile[]>(onUnauthorized);
  const verification = useAction<TeleportProfile>(onUnauthorized);
  const [observed, setObserved] = useState<Record<string, TeleportProfile>>({});
  const load = list.run;
  const given = training ? [exampleTeleport] : list.result;
  const latest = verification.result;

  useEffect(() => {
    if (!training) void load(async signal => (await api.teleport(signal)).profiles);
  }, [training, load]);

  async function verify(profile: TeleportProfile) {
    await verification.run(async signal => {
      const checked: TeleportProfile = training ? { ...profile, status: 'reachable', latency_ms: 42, checked_at: new Date().toISOString(), version: '18.2.0' }
        : (await api.checkTeleport(profile.id, signal)).profile;
      if (!signal.aborted) setObserved(previous => ({ ...previous, [checked.id]: checked }));
      return checked;
    });
  }

  return <section className="guide-teleport" aria-labelledby="guide-teleport-heading">
    <div className="guide-teleport-heading"><Network size={18} aria-hidden="true" /><h3 id="guide-teleport-heading">Веб-прокси Teleport</h3></div>
    <p>Caudal проверяет веб-прокси из своей сети. Вход, права и доступ к целевому хосту проверяются в Teleport.</p>
    {list.pending && <p role="status">Загружаем прокси…</p>}
    {list.error && <Notice>{list.error} <Button variant="ghost" onClick={() => void load(async signal => (await api.teleport(signal)).profiles)}>Повторить загрузку</Button></Notice>}
    {given?.length === 0 && <p>В Caudal пока нет настроенных прокси Teleport.</p>}
    {given?.map(configured => {
      const profile = observed[configured.id] ?? configured;
      const link = !training && httpsLink(profile.web_url);
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
            {verification.pending ? 'Проверяем…' : training ? 'Учебная проверка' : 'Проверить прокси'}
          </Button>
          {link && <a href={link} target="_blank" rel="noreferrer noopener" title="Откроется в новой вкладке">Открыть Teleport <ExternalLink size={14} aria-hidden="true" /></a>}
        </div>
      </div>;
    })}
    {verification.error && <Notice>{verification.error}</Notice>}
    <span className="sr-only" role="status">{latest ? `Проверка ${latest.label} завершена.` : ''}</span>
  </section>;
}

export function Guide({ nodes, controlPlaneNodeId, onEnroll, onChoose, onAssistant, onUnauthorized }: GuideProps) {
  const [step, setStep] = useState<Step>('first');
  const [training, setTraining] = useState(false);
  const [lab] = useState(trainingNodes);
  const heading = useRef<HTMLHeadingElement>(null);
  const visibleNodes = training ? lab : nodes;
  const title = step === 'first' ? 'Первый сигнал' : step === 'history' ? 'Диагностика по измерениям' : 'Доступность с разных точек';
  const contentKey = `${step}:${training}`;

  function next(nextStep: Step) {
    setStep(nextStep);
    requestAnimationFrame(() => heading.current?.focus());
  }

  return <section className="guide" aria-labelledby="guide-heading">
    <div className="view-heading guide-heading">
      <div><h1 id="guide-heading" tabIndex={-1}>Подключение и проверка</h1><p>От первого сигнала до диагностики нескольких VPS.</p></div>
      <div className="guide-mode" role="group" aria-label="Данные руководства">
        <Button variant="ghost" aria-pressed={!training} onClick={() => setTraining(false)}>Мои узлы</Button>
        <Button variant="ghost" aria-pressed={training} onClick={() => setTraining(true)}>Учебный пример</Button>
      </div>
    </div>
    <nav className="guide-levels" aria-label="Этапы подключения">
      {steps.map(({ id, name, icon: Icon }, index) => <Button key={id} variant="ghost" aria-current={id === step ? 'step' : undefined} onClick={() => next(id)}>
        <span className="guide-level-icon"><Icon size={18} aria-hidden="true" /></span>
        <span><small>Этап {index + 1}</small><strong>{name}</strong></span>
      </Button>)}
    </nav>
    {training && <p className="guide-lab-note" role="status">Учебный пример. Узлы и результаты вымышлены. Сетевые проверки отключены.</p>}
    <section className="guide-panel panel" aria-labelledby="guide-step-heading">
      <div className="panel-heading"><h2 ref={heading} id="guide-step-heading" tabIndex={-1}>{title}</h2></div>
      <div className="guide-panel-body" key={contentKey}>
        {step === 'first' && <FirstStep nodes={visibleNodes} training={training} onEnroll={onEnroll} onChoose={onChoose} onNext={() => next('history')} />}
        {step === 'history' && <HistoryStep nodes={visibleNodes} training={training} onChoose={onChoose} onAssistant={onAssistant}
          onUnauthorized={onUnauthorized} onNext={() => next('routes')} />}
        {step === 'routes' && <RouteStep nodes={visibleNodes} training={training} controlPlaneNodeId={controlPlaneNodeId} onUnauthorized={onUnauthorized} />}
      </div>
    </section>
  </section>;
}

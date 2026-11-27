import { useEffect, useState } from 'react';
import { Activity, ArrowLeft, ArrowRight, ChevronRight, CircleDot, Clock3, Cpu, HardDrive, KeyRound, MemoryStick, Plus, Radio, Route, Server } from 'lucide-react';
import { api, ApiError } from '../api';
import { Button } from '../aspect/controls';
import { countStatuses, formatBytes, formatPercent, formatUptime, ratio, recentSamples, type FleetNode, type Sample } from '../domain';
import { Notice, Observation, Status } from './common';
import { FlowArt } from './FlowArt';

function FleetSummary({ nodes, snapshot }: { nodes: FleetNode[]; snapshot: boolean }) {
  const count = countStatuses(nodes);
  const cells = [
    { label: 'Узлы', value: nodes.length, icon: Server, className: 'total' },
    { label: snapshot ? 'Были на связи' : 'На связи', value: count.healthy, icon: Radio, className: 'healthy' },
    { label: 'Данные устарели', value: count.stale, icon: Clock3, className: 'stale' },
    { label: 'Ожидают данные', value: count.pending, icon: CircleDot, className: 'pending' },
  ];
  return <dl className={`metrics-strip${snapshot ? ' is-snapshot' : ''}`} aria-label={snapshot ? 'Последняя доступная сводка парка' : 'Сводка парка'}>
    {cells.map(({ label, value, icon: Icon, className }) => <div className={`strip-cell ${className}`} key={label}>
      <dt><Icon size={15} aria-hidden="true" /> {label}</dt><dd>{value.toLocaleString('ru')}</dd>
    </div>)}
  </dl>;
}

function NodeList({ nodes, onChoose, snapshot, telemetry }: { nodes: FleetNode[]; onChoose: (id: string) => void; snapshot: boolean; telemetry: boolean }) {
  return <ul className="node-list" data-telemetry={telemetry}>
    {nodes.map(node => <li key={node.id}>
      <Button className="node-row" variant="ghost" onClick={() => onChoose(node.id)}>
        <span className="node-row-icon"><Server size={20} aria-hidden="true" /></span>
        <span className="node-identity"><strong>{node.name}</strong>{node.region && <small>{node.region}</small>}</span>
        <span className="node-observation"><small>Последний сигнал</small><Observation value={node.last_seen} /></span>
        {telemetry && <span className="node-telemetry">
          <span><small>CPU</small>{node.metrics ? formatPercent(node.metrics.cpu_percent) : '—'}</span>
          <span><small>RAM</small>{node.metrics ? formatPercent(ratio(node.metrics.memory_used_bytes, node.metrics.memory_total_bytes)) : '—'}</span>
          <span><small>Диск</small>{node.metrics ? formatPercent(ratio(node.metrics.disk_used_bytes, node.metrics.disk_total_bytes)) : '—'}</span>
        </span>}
        <Status status={node.status} snapshot={snapshot} />
        <ChevronRight className="node-chevron" size={17} aria-hidden="true" />
      </Button>
    </li>)}
  </ul>;
}

export function Fleet({ nodes, ready, error, onChoose, onEnroll, onRetry, onGuide, telemetry = false }: {
  nodes: FleetNode[];
  ready: boolean;
  error: string;
  onChoose: (id: string) => void;
  onEnroll: () => void;
  onRetry: () => void;
  onGuide: () => void;
  telemetry?: boolean;
}) {
  const ordered = telemetry ? nodes.toSorted((first, second) => {
    const priority = { stale: 0, pending: 1, healthy: 2 };
    return priority[first.status] - priority[second.status];
  }) : nodes;
  return <section className="fleet" aria-labelledby="fleet-heading">
    <div className={`view-heading${!telemetry && ready && nodes.length > 0 ? ' fleet-banner' : ''}`}>
      {!telemetry && ready && nodes.length > 0 && <FlowArt />}
      <div><h1 id="fleet-heading" tabIndex={-1}>Парк серверов</h1><p>Свежесть данных и нагрузка на ваши серверы.</p></div>
      <Button variant="primary" className="add-node" aria-haspopup="dialog" onClick={onEnroll} disabled={!ready}>
        <Plus size={18} aria-hidden="true" /> Подключить узел
      </Button>
    </div>
    {error && <Notice><span>{error}{ready && ' Показана последняя доступная сводка.'}</span> <Button variant="ghost" onClick={onRetry}>Повторить</Button></Notice>}
    {ready && <FleetSummary nodes={nodes} snapshot={Boolean(error)} />}
    <section className="panel fleet-panel" aria-labelledby="node-list-title">
      <div className="panel-heading"><div><h2 id="node-list-title">Узлы</h2><p>Источник данных — сборщик Caudal</p></div>{ready && <span className="count-label">{nodes.length}</span>}</div>
      {!ready && !error && <div className="panel-message" role="status"><span className="status-dot" /> Загружаем парк…</div>}
      {!ready && error && <div className="panel-message">Список узлов недоступен.</div>}
      {ready && nodes.length === 0 && <div className="fleet-empty">
        <div className="empty-content">
          <div className="empty-icon"><Radio size={22} aria-hidden="true" /></div>
          <h3>Подключите первый узел</h3>
          <p>Установите лёгкий сборщик на свой Linux-сервер. Он начнёт отправлять метрики по HTTPS.</p>
          <div className="fleet-cta">
            <Button variant="secondary" className="empty-action" aria-haspopup="dialog" onClick={onEnroll}>Настроить сборщик <ArrowRight size={16} aria-hidden="true" /></Button>
            <Button variant="ghost" className="guide-link" onClick={onGuide}><Route size={15} aria-hidden="true" /> Маршруты подключения</Button>
          </div>
        </div>
        <FlowArt />
      </div>}
      {ready && nodes.length > 0 && <NodeList nodes={ordered} onChoose={onChoose} snapshot={Boolean(error)} telemetry={telemetry} />}
    </section>
    {ready && nodes.length > 0 && <Button variant="ghost" className="guide-link fleet-guide" onClick={onGuide}><Route size={15} aria-hidden="true" /> Маршруты подключения <ArrowRight size={15} aria-hidden="true" /></Button>}
    {ready && <p className="fleet-footnote"><Activity size={16} aria-hidden="true" /> Состояние отражает свежесть сигнала от сборщика.</p>}
  </section>;
}

export function NodeDetail({ node, goBack, onUnauthorized, onRotate, snapshot }: {
  node: FleetNode; goBack: () => void; onUnauthorized: () => void; onRotate: () => void; snapshot: boolean;
}) {
  const [samples, setSamples] = useState<Sample[]>();
  const [historyError, setHistoryError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const nodeId = node.id;
  const lastSeen = node.last_seen;
  useEffect(() => {
    const controller = new AbortController();
    api.samples(nodeId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setSamples(result.samples ?? []);
      setHistoryError('');
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else setHistoryError(error instanceof Error ? error.message : 'История недоступна.');
    });
    return () => controller.abort();
  }, [nodeId, lastSeen, attempt, onUnauthorized]);

  const current = node.metrics;
  const resources = current ? [
    { label: 'Загрузка CPU', value: formatPercent(current.cpu_percent), percent: current.cpu_percent, icon: Cpu },
    { label: 'Оперативная память', value: formatBytes(current.memory_used_bytes), percent: ratio(current.memory_used_bytes, current.memory_total_bytes), detail: `из ${formatBytes(current.memory_total_bytes)}`, icon: MemoryStick },
    { label: 'Корневой диск', value: formatBytes(current.disk_used_bytes), percent: ratio(current.disk_used_bytes, current.disk_total_bytes), detail: `из ${formatBytes(current.disk_total_bytes)}`, icon: HardDrive },
    { label: 'Время работы', value: formatUptime(current.uptime_seconds), percent: undefined, icon: Clock3 },
  ] : [];
  const history = samples ? recentSamples(samples, 16) : undefined;

  return <section className="fleet" aria-labelledby="fleet-heading">
    <div className="detail-actions">
      <Button variant="ghost" className="back-button" onClick={goBack}><ArrowLeft size={16} aria-hidden="true" /> К списку</Button>
      <Button variant="ghost" className="back-button" aria-haspopup="dialog" onClick={onRotate}><KeyRound size={16} aria-hidden="true" /> Заменить токен</Button>
    </div>
    <div className="view-heading detail-heading"><div><h1 id="fleet-heading" tabIndex={-1}>{node.name}</h1><p>{node.region || 'Регион не указан'}</p></div><Status status={node.status} snapshot={snapshot} /></div>
    <div className="detail-signal panel">
      <span className="node-row-icon"><Radio size={20} aria-hidden="true" /></span><div><strong>Последний сигнал</strong><p><Observation value={node.last_seen} /></p></div>
      {(node.status === 'stale' || snapshot) && <span className="signal-stale-note">Показан последний полученный снимок.</span>}
    </div>
    {current ? <dl className="resource-grid" aria-label="Ресурсы узла">
      {resources.map(({ label, value, percent, detail, icon: Icon }) => <div className="resource-card panel" key={label}>
        <dt><Icon size={16} aria-hidden="true" /> {label}</dt><dd>{value}{detail && <small>{detail}</small>}</dd>
        {percent !== undefined && <meter min={0} max={100} value={percent} aria-label={label} />}
      </div>)}
    </dl> : <div className="panel panel-message"><CircleDot size={17} aria-hidden="true" /> Сборщик ещё не отправил метрики.</div>}
    <section className="panel history-panel" aria-labelledby="history-title">
      <div className="panel-heading"><div><h2 id="history-title">История сигналов</h2><p>Загрузка CPU по последним снимкам</p></div><Activity size={18} aria-hidden="true" /></div>
      {historyError && <Notice>{historyError} <Button variant="ghost" onClick={() => setAttempt(old => old + 1)}>Повторить</Button></Notice>}
      {history?.length ? <>
        <div className="history-chart" aria-hidden="true">
          <div className="chart-legend"><span>100%</span><span>50%</span><span>0%</span></div>
          <div className="chart-bars">
            {history.map((sample, index) => <div className="chart-column" key={`${sample.observed_at}-${index}`}>
              <span className="chart-bar" style={{ height: `${Math.max(2, Math.min(100, sample.metrics.cpu_percent))}%` }} />
            </div>)}
          </div>
        </div>
        <details className="history-details"><summary>Данные графика</summary><table><thead><tr><th scope="col">Сигнал</th><th scope="col">CPU</th></tr></thead>
          <tbody>{history.map((sample, index) => <tr key={`${sample.observed_at}-${index}`}><td><Observation value={sample.observed_at} /></td><td>{formatPercent(sample.metrics.cpu_percent)}</td></tr>)}</tbody></table></details>
      </> : <div className="panel-message">{history ? 'Снимков пока нет.' : historyError ? 'Снимки недоступны.' : 'Загружаем историю…'}</div>}
    </section>
  </section>;
}

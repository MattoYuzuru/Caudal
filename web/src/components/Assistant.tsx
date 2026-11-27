import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, Check, ChevronDown, CircleStop, Radio, Settings2, Sparkles, X } from 'lucide-react';
import { api, ApiError } from '../api';
import { Badge, Button, Textarea } from '../aspect/controls';
import { receiptFragment } from '../domain';
import type { AssistantMode, AssistantReply, FleetNode, OperationRun } from '../domain';
import { CopyButton, Notice, Observation, Status } from './common';
import './assistant.css';

const ReplyMarkdown = lazy(() => import('./ReplyMarkdown').then(module => ({ default: module.ReplyMarkdown })));
const prompts = [
  { label: 'Какие узлы требуют внимания?', prompt: 'Какие узлы требуют внимания? Укажи, где сигнал устарел и где пока нет данных.' },
  { label: 'Где больше свободной памяти?', prompt: 'Сравни свободную оперативную память по свежим наблюдениям.' },
];
const effects = { read: 'Чтение', change: 'Изменение', destructive: 'Разрушающее действие' } as const;
const transports = { fleet: 'Caudal', ssh: 'SSH', tsh: 'tsh', http: 'HTTPS', teleport: 'Teleport' } as const;
const runStatuses = { awaiting_approval: 'Ожидает подтверждения', completed: 'Выполнено', cancelled: 'Отменено' } as const;
const resultStatuses = { ok: 'Успешно', failed: 'Ошибка', unknown: 'Результат не подтверждён' } as const;

type Model = 'deepseek-flash' | 'deepseek-v4-pro';
type Effort = 'none' | 'high' | 'max';
type Decision = 'approve' | 'cancel';
type LinkedReceipt = { id: string; run: OperationRun } | { id: string; error: string };
const receiptUnavailable = 'Квитанция недоступна. Проверьте ссылку и срок хранения запуска.';
type Turn = {
  id: number;
  query: string;
  scope: string;
  mode: AssistantMode;
  result?: AssistantReply;
  issue?: string;
};

function numberedResults(run: OperationRun) {
  let index = 0;
  const validId = /^[a-f0-9]{32}$/.test(run.id);
  return (run.results ?? []).map(result => ({
    ...result,
    numbered: result.lines.map(text => {
      const number = ++index;
      return { number, text, anchor: validId ? `run-${run.id}-L${number}` : undefined };
    }),
  }));
}

function RunReceipt({ run, onChange, onFollowUp, onUnauthorized }: {
  run: OperationRun;
  onChange: (run: OperationRun) => void;
  onFollowUp: (id: string) => void;
  onUnauthorized: () => void;
}) {
  const [pending, setPending] = useState<Decision>();
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => request.current?.abort(), []);
  const incomplete = run.status === 'completed' && run.results?.some(result => result.status !== 'ok');

  async function decide(action: Decision) {
    if (request.current || run.status !== 'awaiting_approval') return;
    const call = new AbortController();
    request.current = call;
    setPending(action);
    setError('');
    try {
      const response = await (action === 'approve' ? api.approveRun(run.id, call.signal) : api.cancelRun(run.id, call.signal));
      if (call.signal.aborted) return;
      if (response.run.id !== run.id) throw new Error('Сервер вернул другой запуск.');
      onChange(response.run);
      requestAnimationFrame(() => heading.current?.focus());
    } catch (failure) {
      if (call.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) onUnauthorized();
      else setError(failure instanceof Error ? failure.message : 'Не удалось обновить запуск.');
    } finally {
      request.current = null;
      if (!call.signal.aborted) setPending(undefined);
    }
  }

  return <section className="assistant-run" aria-label="Операции ассистента" aria-busy={Boolean(pending)}>
    <div className="assistant-run-heading"><h3 ref={heading} tabIndex={-1}>{run.status === 'completed' ? 'Результат запуска' : 'План действий'}</h3>
      <Badge tone={incomplete || run.status === 'awaiting_approval' ? 'warning' : run.status === 'completed' ? 'success' : 'neutral'}>{incomplete ? 'Завершён' : runStatuses[run.status]}</Badge></div>
    <ol className="assistant-run-operations" aria-label="Запланированные операции">
      {run.operations.map(operation => <li key={operation.id}>
        <div><strong>{operation.label}</strong><span>{operation.target}</span></div>
        <div className="assistant-operation-tags"><Badge>{transports[operation.transport]}{operation.method ? ` · ${operation.method}` : ''}</Badge>
          <Badge tone={operation.effect === 'destructive' ? 'danger' : operation.effect === 'change' ? 'warning' : 'neutral'}>{effects[operation.effect]}</Badge></div>
      </li>)}
    </ol>
    {numberedResults(run).map(result => <div className="assistant-operation-result" key={result.operation_id}>
      <div className="assistant-output-heading">
        <strong>{run.operations.find(operation => operation.id === result.operation_id)?.label ?? result.operation_id}</strong>
        <span><Badge tone={result.status === 'ok' ? 'success' : 'warning'}>{resultStatuses[result.status]}</Badge> {result.duration_ms} мс</span>
      </div>
      {result.numbered.length > 0 ? <ol className="assistant-output-lines" aria-label="Строки вывода">
        {result.numbered.map(({ number, text, anchor }) => <li value={number} className="assistant-output-line" id={anchor} key={number} tabIndex={-1}>
          {anchor ? <a href={`#${anchor}`} className="assistant-line-number" aria-label={`Строка ${number}`}>{number}</a>
            : <span className="assistant-line-number">{number}</span>}
          <code>{text}</code>
          {anchor && <CopyButton value={new URL(`#${anchor}`, window.location.href).href} label={`Скопировать ссылку на строку ${number}`} />}
        </li>)}
      </ol> : <p className="assistant-output-empty">Нет строк вывода.</p>}
    </div>)}
    {error && <Notice>{error}</Notice>}
    {run.status === 'awaiting_approval' && <div className="assistant-run-actions">
      <Button variant="primary" disabled={Boolean(pending)} onClick={() => void decide('approve')}>
        <Check size={15} aria-hidden="true" />{pending === 'approve' ? 'Подтверждаем…' : 'Подтвердить запуск'}
      </Button>
      <Button variant="ghost" disabled={Boolean(pending)} onClick={() => void decide('cancel')}>
        {pending === 'cancel' ? 'Отменяем…' : 'Отменить запуск'}
      </Button>
    </div>}
    {run.status === 'completed' && (run.results?.length ?? 0) > 0 && <div className="assistant-run-actions">
      <Button variant="ghost" onClick={() => onFollowUp(run.id)}><Sparkles size={15} aria-hidden="true" />Спросить по результату</Button>
    </div>}
  </section>;
}

export function Assistant({ nodes, selected, providerKey, autoApproveRead, onChoose, onSettings, onUnauthorized }: {
  nodes: FleetNode[];
  selected?: FleetNode;
  providerKey: string;
  autoApproveRead: boolean;
  onChoose: (id: string) => void;
  onSettings: () => void;
  onUnauthorized: () => void;
}) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<AssistantMode>('local');
  const [model, setModel] = useState<Model>('deepseek-flash');
  const [effort, setEffort] = useState<Effort>('none');
  const [serverKey, setServerKey] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const [contextRun, setContextRun] = useState<string>();
  const [fleetScopeFor, setFleetScopeFor] = useState<string>();
  const [hash, setHash] = useState(() => window.location.hash);
  const [linkedReceipt, setLinkedReceipt] = useState<LinkedReceipt>();
  const controller = useRef<AbortController | undefined>(undefined);
  const nextId = useRef(0);
  const questionField = useRef<HTMLTextAreaElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const rememberHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', rememberHash);
    return () => window.removeEventListener('hashchange', rememberHash);
  }, []);
  useEffect(() => {
    const call = new AbortController();
    void api.assistantStatus(call.signal).then(result => {
      if (!call.signal.aborted) setServerKey(result.deepseek_configured);
    }).catch((error: unknown) => {
      if (!call.signal.aborted && error instanceof ApiError && error.status === 401) onUnauthorized();
    });
    return () => call.abort();
  }, [onUnauthorized]);
  const deepseekReady = Boolean(providerKey.trim()) || serverKey;
  const scopeNode = selected && fleetScopeFor !== selected.id ? selected : undefined;
  const fragment = receiptFragment(hash);
  const requestedId = fragment?.id;
  const firstRunTurn = new Map<string, number>();
  const visibleRuns: OperationRun[] = [];
  for (const turn of turns) {
    const run = turn.result?.run;
    if (!run || firstRunTurn.has(run.id)) continue;
    firstRunTurn.set(run.id, turn.id);
    visibleRuns.push(run);
  }
  const inConversation = Boolean(requestedId && firstRunTurn.has(requestedId));
  const loaded = !inConversation && requestedId && linkedReceipt?.id === requestedId ? linkedReceipt : undefined;
  const linkedRun = loaded && 'run' in loaded ? loaded.run : undefined;
  if (linkedRun) visibleRuns.push(linkedRun);
  const knownAnchors = new Set<string>();
  for (const run of visibleRuns) {
    for (const result of numberedResults(run)) {
      for (const line of result.numbered) {
        if (line.anchor) knownAnchors.add(`#${line.anchor}`);
      }
    }
  }
  const linkedAnchor = fragment && knownAnchors.has(`#${fragment.anchor}`) ? fragment.anchor : undefined;

  useEffect(() => {
    if (!requestedId || inConversation) return;
    const call = new AbortController();
    void api.run(requestedId, call.signal).then(({ run }) => {
      if (call.signal.aborted) return;
      if (run.id === requestedId && run.status === 'completed') setLinkedReceipt({ id: requestedId, run });
      else setLinkedReceipt({ id: requestedId, error: receiptUnavailable });
    }).catch((failure: unknown) => {
      if (call.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) onUnauthorized();
      else setLinkedReceipt({ id: requestedId, error: receiptUnavailable });
    });
    return () => call.abort();
  }, [requestedId, inConversation, onUnauthorized]);

  useEffect(() => {
    if (!linkedAnchor) return;
    const frame = requestAnimationFrame(() => {
      const line = document.getElementById(linkedAnchor);
      line?.focus({ preventScroll: true });
      line?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [linkedAnchor]);

  useEffect(() => {
    if (conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [turns.length, pending]);

  function updateRun(run: OperationRun) {
    setTurns(previous => previous.map(turn => turn.result?.run?.id === run.id ? { ...turn, result: { ...turn.result, run } } : turn));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = query.trim();
    if (!message || controller.current || (mode === 'deepseek' && !deepseekReady)) return;
    const call = new AbortController();
    const turn: Turn = { id: nextId.current++, query: message, scope: scopeNode?.name ?? 'Все узлы', mode };
    controller.current = call;
    setPending(true);
    setQuery('');
    setTurns(previous => [
      ...previous.filter((item, index) => index >= previous.length - 19 ||
        item.result?.run?.status === 'awaiting_approval' || Boolean(contextRun && item.result?.run?.id === contextRun)),
      turn,
    ]);

    function finish(update: Partial<Turn>) {
      setTurns(previous => previous.map(item => item.id === turn.id ? { ...item, ...update } : item));
    }

    try {
      const result = await api.ask(message, scopeNode?.id, mode, mode === 'deepseek' ? providerKey.trim() || undefined : undefined, call.signal,
        { auto_approve_read: autoApproveRead, run_id: contextRun, ...(mode === 'deepseek' ? { model, effort } : {}) });
      if (!call.signal.aborted) {
        if (result.run) updateRun(result.run);
        finish({ result });
      }
    } catch (error) {
      if (call.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else finish({ issue: error instanceof Error ? error.message : 'Не удалось получить ответ.' });
    } finally {
      if (controller.current === call) {
        controller.current = undefined;
        setPending(false);
      }
    }
  }

  function stop() {
    controller.current?.abort();
    controller.current = undefined;
    setPending(false);
    setTurns(previous => previous.map(item => item.result || item.issue ? item : { ...item, issue: 'Запрос остановлен.' }));
    questionField.current?.focus();
  }

  function followUp(id: string) {
    setContextRun(id);
    setQuery(previous => previous.trim() ? previous : 'Что важно в этом результате?');
    questionField.current?.focus();
  }

  return <section className="assistant panel" aria-labelledby="assistant-heading">
    <div className="panel-heading assistant-heading">
      <span className="assistant-icon"><Sparkles size={19} aria-hidden="true" /></span>
      <div><h2 id="assistant-heading" tabIndex={-1}>Ассистент</h2><p>Анализ по снимкам узлов</p></div>
    </div>
    <div className="assistant-provider-controls" data-tour="assistant-provider">
      <div className="assistant-modes" role="group" aria-label="Режим ассистента">
        <Button variant="ghost" aria-pressed={mode === 'local'} onClick={() => setMode('local')}>Локальная сводка</Button>
        <Button variant="ghost" aria-pressed={mode === 'deepseek'} onClick={() => setMode('deepseek')}>DeepSeek</Button>
      </div>
      {mode === 'deepseek' && <div className="assistant-model-options">
        <label><span id="assistant-model-label">Модель</span><select className="aspect-input" aria-labelledby="assistant-model-label" value={model} onChange={event => setModel(event.target.value as Model)}>
          <option value="deepseek-flash">DeepSeek Flash</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
        </select></label>
        <label><span id="assistant-effort-label">Рассуждение</span><select className="aspect-input" aria-labelledby="assistant-effort-label" value={effort} onChange={event => setEffort(event.target.value as Effort)}>
          <option value="none">Без рассуждения</option><option value="high">Высокое</option><option value="max">Максимальное</option>
        </select></label>
      </div>}
      {mode === 'deepseek' && !deepseekReady && <div className="assistant-provider-help">
        <p role="status">Для DeepSeek нужен ключ API.</p>
        <Button variant="ghost" onClick={onSettings}><Settings2 size={15} aria-hidden="true" />Настройки подключения</Button>
      </div>}
    </div>
    <div className="assistant-conversation" ref={conversation}>
      {fragment && !inConversation && !loaded && <p className="assistant-linked-status" role="status">Открываем сохранённую квитанцию…</p>}
      {loaded && 'error' in loaded && <Notice>{loaded.error}</Notice>}
      {fragment && (inConversation || linkedRun) && !linkedAnchor && <Notice>В квитанции нет строки с таким номером.</Notice>}
      {linkedRun && <div className="assistant-linked-receipt">
        <p className="assistant-linked-status">Квитанция по ссылке</p>
        <RunReceipt run={linkedRun} onChange={updateRun} onFollowUp={followUp} onUnauthorized={onUnauthorized} />
      </div>}
      {turns.length === 0 && !fragment && <div className="assistant-start">
        <p>Начните с вопроса о свежести данных или нагрузке.</p>
        <div className="suggestions">{prompts.map(({ label, prompt }) => <Button key={label} variant="ghost"
          onClick={() => { setQuery(prompt); questionField.current?.focus(); }}>{label}<ArrowUp size={14} aria-hidden="true" /></Button>)}</div>
      </div>}
      {turns.length > 0 && <div role="log" aria-label="Диалог с ассистентом" aria-live="polite">
        {turns.map(turn => <article className="assistant-turn" key={turn.id}>
          <div className="assistant-question"><span>Вы · {turn.scope}</span><p>{turn.query}</p></div>
          {turn.issue && <Notice>{turn.issue}
            {turn.mode === 'deepseek' && <Button variant="ghost" onClick={() => { setMode('local'); setQuery(turn.query); questionField.current?.focus(); }}>Использовать локальную сводку</Button>}
          </Notice>}
          {!turn.result && !turn.issue && <p className="answer-wait"><span className="status-dot" /> Готовим ответ…</p>}
          {turn.result && <div className="assistant-reply"><div className="reply-author"><Sparkles size={15} aria-hidden="true" /> {turn.result.source === 'deepseek' ? 'DeepSeek' : 'Локальная сводка'}</div>
            <Suspense fallback={<p>{turn.result.answer}</p>}><ReplyMarkdown answer={turn.result.answer} anchors={knownAnchors} /></Suspense>
            {turn.result.run && firstRunTurn.get(turn.result.run.id) === turn.id && <RunReceipt run={turn.result.run} onChange={updateRun} onFollowUp={followUp} onUnauthorized={onUnauthorized} />}
            {turn.result.evidence?.length > 0 && <details className="evidence-details">
              <summary><Radio size={15} aria-hidden="true" /> Снимки <span>{turn.result.evidence.length}</span><ChevronDown size={14} aria-hidden="true" /></summary>
              <ul>{turn.result.evidence.map(item => <li key={item.node_id}>
                <Button variant="ghost" onClick={() => onChoose(item.node_id)} className="evidence-node">{item.name}</Button>
                <Status status={item.status} /><Observation value={item.observed_at} />
              </li>)}</ul>
            </details>}
          </div>}
        </article>)}
      </div>}
    </div>
    <form className="assistant-form" data-tour="assistant-composer" onSubmit={event => void submit(event)}>
      <div className="assistant-scope-row">
        <label className="composer-label" htmlFor="question"><Radio size={14} aria-hidden="true" /> {scopeNode?.name ?? 'Все узлы'}</label>
        {selected && <Button variant="ghost" onClick={() => setFleetScopeFor(scopeNode ? selected.id : undefined)}>
          {scopeNode ? 'Все узлы' : 'К выбранному узлу'}
        </Button>}
      </div>
      {contextRun && <div className="assistant-context"><span>Контекст · результат запуска</span>
        <Button variant="ghost" onClick={() => setContextRun(undefined)} aria-label="Убрать результат из контекста"><X size={14} aria-hidden="true" /></Button></div>}
      <Textarea id="question" ref={questionField} aria-label="Вопрос ассистенту" placeholder={nodes.length ? 'Спросите про инфраструктуру…' : 'Спросите, с чего начать…'}
        aria-describedby="provider-disclosure" rows={2} maxLength={1600} value={query} onChange={event => setQuery(event.target.value)} />
      <div className="composer-actions"><span id="provider-disclosure">{mode === 'deepseek'
        ? `DeepSeek получит вопрос, сводку узлов и каталог операций.${contextRun ? ' Добавится вывод выбранного запуска.' : ''}`
        : 'Локальная сводка по последним замерам.'}</span>
        {pending ? <Button variant="ghost" aria-label="Остановить запрос" onClick={stop} className="icon-button"><CircleStop size={19} aria-hidden="true" /></Button>
          : <Button variant="primary" type="submit" className="icon-button" aria-label="Отправить вопрос" disabled={!query.trim() || (mode === 'deepseek' && !deepseekReady)}><ArrowUp size={19} aria-hidden="true" /></Button>}
      </div>
    </form>
  </section>;
}

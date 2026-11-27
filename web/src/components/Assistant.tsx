import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, ChevronDown, CircleStop, KeyRound, Radio, Sparkles } from 'lucide-react';
import { api, ApiError } from '../api';
import { Button, Input, Textarea } from '../aspect/controls';
import type { AssistantMode, AssistantReply, FleetNode } from '../domain';
import { Notice, Observation, Status } from './common';
import './assistant.css';

const prompts = [
  { label: 'Какие узлы требуют внимания?', prompt: 'Какие узлы требуют внимания? Укажи, где сигнал устарел и где пока нет данных.' },
  { label: 'Где больше свободной памяти?', prompt: 'Сравни свободную оперативную память по свежим наблюдениям.' },
];

type Turn = {
  id: number;
  query: string;
  scope: string;
  mode: AssistantMode;
  result?: AssistantReply;
  issue?: string;
};

export function Assistant({ nodes, selected, onChoose, onUnauthorized }: {
  nodes: FleetNode[];
  selected?: FleetNode;
  onChoose: (id: string) => void;
  onUnauthorized: () => void;
}) {
  const [query, setQuery] = useState('');
  const [key, setKey] = useState('');
  const [mode, setMode] = useState<AssistantMode>('local');
  const [serverKey, setServerKey] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const nextId = useRef(0);
  const questionField = useRef<HTMLTextAreaElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const providerSettings = useRef<HTMLDetailsElement>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const call = new AbortController();
    void api.assistantStatus(call.signal).then(result => setServerKey(result.deepseek_configured)).catch((error: unknown) => {
      if (!call.signal.aborted && error instanceof ApiError && error.status === 401) onUnauthorized();
    });
    return () => call.abort();
  }, [onUnauthorized]);
  const deepseekReady = Boolean(key.trim()) || serverKey;
  function chooseMode(next: AssistantMode) {
    setMode(next);
    if (next === 'deepseek' && !deepseekReady && providerSettings.current) {
      providerSettings.current.open = true;
    }
  }
  useEffect(() => {
    if (conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
  }, [turns]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = query.trim();
    if (!message || controller.current || (mode === 'deepseek' && !deepseekReady)) return;
    const call = new AbortController();
    const turn: Turn = { id: nextId.current++, query: message, scope: selected?.name ?? 'Все узлы', mode };
    controller.current = call;
    setPending(true);
    setQuery('');
    setTurns(previous => [...previous.slice(-19), turn]);

    function finish(update: Partial<Turn>) {
      setTurns(previous => previous.map(item => item.id === turn.id ? { ...item, ...update } : item));
    }

    try {
      const result = await api.ask(message, selected?.id, mode, mode === 'deepseek' ? key.trim() || undefined : undefined, call.signal);
      if (!call.signal.aborted) finish({ result });
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

  return <section className="assistant panel" aria-labelledby="assistant-heading">
    <div className="panel-heading assistant-heading">
      <span className="assistant-icon"><Sparkles size={19} aria-hidden="true" /></span>
      <div><h2 id="assistant-heading" tabIndex={-1}>Ассистент</h2><p>Анализ по снимкам узлов</p></div>
      <span className="provider">{mode === 'local' ? 'Локально' : 'DeepSeek'}</span>
    </div>
    <div className="assistant-modes" role="group" aria-label="Режим ассистента">
      <Button variant="ghost" aria-pressed={mode === 'local'} onClick={() => chooseMode('local')}>Локальная сводка</Button>
      <Button variant="ghost" aria-pressed={mode === 'deepseek'} onClick={() => chooseMode('deepseek')}>DeepSeek</Button>
    </div>
    <details className="assistant-key" ref={providerSettings}>
      <summary><KeyRound size={15} aria-hidden="true" /> {key ? 'Ключ DeepSeek добавлен' : 'Настройки DeepSeek'} <ChevronDown size={14} aria-hidden="true" /></summary>
      <div className="assistant-key-form"><label htmlFor="provider-key">Ключ API</label>
        <Input id="provider-key" type="password" autoComplete="off" spellCheck={false} maxLength={256} value={key} onChange={event => setKey(event.target.value)} />
        <p>Ключ хранится в памяти этой страницы и удаляется при выходе или перезагрузке.</p>
        {key && <Button variant="ghost" className="key-remove" onClick={() => setKey('')}>Удалить ключ</Button>}
      </div>
    </details>
    {mode === 'deepseek' && !deepseekReady && <p className="assistant-provider-help" role="status">Добавьте ключ для DeepSeek. Локальная сводка доступна сразу.</p>}
    <div className="assistant-conversation" ref={conversation}>
      {turns.length === 0 ? <div className="assistant-start">
        <p>Начните с вопроса о свежести данных или нагрузке.</p>
        <div className="suggestions">{prompts.map(({ label, prompt }) => <Button key={label} variant="ghost"
          onClick={() => { setQuery(prompt); questionField.current?.focus(); }}>{label}<ArrowUp size={14} aria-hidden="true" /></Button>)}</div>
      </div> : <div role="log" aria-label="Диалог с ассистентом" aria-live="polite">
        {turns.map(turn => <article className="assistant-turn" key={turn.id}>
          <div className="assistant-question"><span>Вы · {turn.scope}</span><p>{turn.query}</p></div>
          {turn.issue && <Notice>{turn.issue}
            {turn.mode === 'deepseek' && <Button variant="ghost" onClick={() => { setMode('local'); setQuery(turn.query); questionField.current?.focus(); }}>Использовать локальную сводку</Button>}
          </Notice>}
          {!turn.result && !turn.issue && <p className="answer-wait"><span className="status-dot" /> Готовим ответ…</p>}
          {turn.result && <div className="assistant-reply"><div className="reply-author"><Sparkles size={15} aria-hidden="true" /> {turn.result.source === 'deepseek' ? 'DeepSeek' : 'Локальная сводка'}</div>
            <p>{turn.result.answer}</p>
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
    <form className="assistant-form" onSubmit={event => void submit(event)}>
      <label className="composer-label" htmlFor="question"><Radio size={14} aria-hidden="true" /> {selected ? selected.name : 'Все узлы'}</label>
      <Textarea id="question" ref={questionField} aria-label="Вопрос ассистенту" placeholder={nodes.length ? 'Спросите про инфраструктуру…' : 'Спросите, с чего начать…'}
        aria-describedby="provider-disclosure" rows={2} maxLength={1600} value={query} onChange={event => setQuery(event.target.value)} />
      <div className="composer-actions"><span id="provider-disclosure">{mode === 'deepseek'
        ? 'DeepSeek получит вопрос, имена, регионы, время и метрики выбранных узлов.'
        : 'Caudal рассчитает сводку по последним замерам без внешней модели.'}</span>
        {pending ? <Button variant="ghost" aria-label="Остановить запрос" onClick={stop} className="icon-button"><CircleStop size={19} aria-hidden="true" /></Button>
          : <Button variant="primary" type="submit" className="icon-button" aria-label="Отправить вопрос" disabled={!query.trim() || (mode === 'deepseek' && !deepseekReady)}><ArrowUp size={19} aria-hidden="true" /></Button>}
      </div>
    </form>
  </section>;
}

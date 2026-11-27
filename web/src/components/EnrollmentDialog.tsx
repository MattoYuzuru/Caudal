import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, CircleCheck, Terminal } from 'lucide-react';
import { api, ApiError } from '../api';
import { Button, Dialog, Input } from '../aspect/controls';
import { collectorCommands, type Architecture, type Enrollment, type FleetNode } from '../domain';
import { CopyButton, Field, Notice } from './common';

function Command({ title, value }: { title: string; value: string }) {
  return <div className="command">
    <div className="command-header"><span><Terminal size={15} aria-hidden="true" />{title}</span><CopyButton label={`Скопировать. ${title}`} value={value} /></div>
    <pre><code>{value}</code></pre>
  </div>;
}

function Setup({ enrollment, onFinish, rotated }: { enrollment: Enrollment; onFinish: () => void; rotated: boolean }) {
  const [architecture, setArchitecture] = useState<Architecture>('amd64');
  const [reveal, setReveal] = useState(false);
  const commands = collectorCommands(window.location.origin, enrollment.node.id, architecture);

  return <div className="setup">
    <p className="setup-notice"><CircleCheck size={18} aria-hidden="true" /><span>{rotated ? 'Новый токен выпущен для узла ' : 'Зарегистрирован узел '}<strong>{enrollment.node.name}</strong>.</span></p>
    <label className="field setup-architecture"><span>Архитектура сервера</span>
      <select value={architecture} className="aspect-input" onChange={event => setArchitecture(event.target.value as Architecture)}>
        <option value="amd64">Linux x86_64 (amd64)</option>
        <option value="arm64">Linux aarch64 (arm64)</option>
      </select>
    </label>
    {!rotated && <Command title="Загрузить сборщик" value={commands.download} />}
    <Command title="Сохранить токен на сервере" value={commands.configure} />
    <div className="token-field">
      <div><label htmlFor="collector-token">Токен сборщика</label><small>Вставьте его по запросу в терминале. Токен показывается только здесь.</small></div>
      <div className="token-controls">
        <Input id="collector-token" value={enrollment.token} type={reveal ? 'text' : 'password'} readOnly autoComplete="off" spellCheck={false} />
        <Button variant="ghost" className="reveal-button" aria-pressed={reveal} onClick={() => setReveal(previous => !previous)}>{reveal ? 'Скрыть' : 'Показать'}</Button>
        <CopyButton value={enrollment.token} label="Скопировать токен сборщика" />
      </div>
    </div>
    <Command title="Запустить сборщик" value={commands.start} />
    <p className="setup-note">{rotated ? 'Если сборщик работает как служба, обновите её файл токена и перезапустите службу.'
      : 'Оставьте сборщик запущенным. После первого сигнала данные появятся в карточке узла.'}</p>
    <div className="dialog-actions"><Button variant="primary" onClick={onFinish}>К узлу <ArrowRight size={16} aria-hidden="true" /></Button></div>
  </div>;
}

export function EnrollmentDialog({ onClose, onCreated, onUnauthorized, rotateNode }: {
  onClose: () => void;
  onCreated: (node: FleetNode) => void;
  onUnauthorized: () => void;
  rotateNode?: FleetNode;
}) {
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const call = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => call.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (call.current) return;
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') ?? '').trim();
    const region = String(data.get('region') ?? '').trim();
    if (!rotateNode && !name) {
      setError('Укажите имя узла.');
      return;
    }
    const controller = new AbortController();
    call.current = controller;
    setPending(true);
    setError('');
    try {
      const result = rotateNode ? { node: rotateNode, ...await api.rotate(rotateNode.id, controller.signal) }
        : await api.enroll(name, region, controller.signal);
      if (controller.signal.aborted) return;
      if (!rotateNode) onCreated(result.node);
      setEnrollment(result);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 401) onUnauthorized();
      else setError(failure instanceof Error ? failure.message : 'Не удалось подготовить токен.');
    } finally {
      if (!controller.signal.aborted) {
        call.current = undefined;
        setPending(false);
      }
    }
  }

  return <Dialog open onClose={() => { if (!pending) onClose(); }} closeLabel="Закрыть подключение"
    title={enrollment ? 'Настройка сборщика' : rotateNode ? 'Заменить токен' : 'Подключить узел'}
    description={enrollment ? undefined : rotateNode ? `Старый токен узла «${rotateNode.name}» перестанет работать сразу. Обновите файл токена на сервере и перезапустите сборщик.`
      : 'Укажите данные своего сервера. Caudal выдаст токен для лёгкого сборщика.'}>
    {enrollment ? <Setup enrollment={enrollment} onFinish={onClose} rotated={Boolean(rotateNode)} /> : <form className="form-stack" onSubmit={event => void submit(event)}>
      {!rotateNode && <><Field label="Имя узла"><Input name="name" maxLength={64} required placeholder="Например, mnema" autoComplete="off" /></Field>
        <Field label="Регион" hint="Необязательно"><Input name="region" maxLength={64} placeholder="Например, Москва" autoComplete="off" /></Field></>}
      {error && <Notice>{error}</Notice>}
      <div className="dialog-actions">
        <Button variant="ghost" onClick={onClose} disabled={pending}>Отмена</Button>
        <Button variant={rotateNode ? 'danger' : 'primary'} type="submit" disabled={pending}>{pending ? 'Подготавливаем…' : rotateNode ? 'Заменить токен' : 'Создать узел'}<ArrowRight size={16} aria-hidden="true" /></Button>
      </div>
    </form>}
  </Dialog>;
}

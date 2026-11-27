import { useState, type ReactNode } from 'react';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { Badge, Button } from '../aspect/controls';
import { formatObservation, statuses, type NodeStatus } from '../domain';

export function BrandMark() {
  return <span className="brand-mark" aria-hidden="true">
    <img className="brand-light" src="/caudal-light.svg" alt="" width={38} height={38} />
    <img className="brand-dark" src="/caudal-dark.svg" alt="" width={38} height={38} />
  </span>;
}

export function Brand() {
  return <div className="brand"><BrandMark /><span>Caudal</span></div>;
}

export function Status({ status, snapshot = false }: { status: NodeStatus; snapshot?: boolean }) {
  const label = snapshot && status === 'healthy' ? 'Был на связи' : statuses[status].label;
  return <Badge className="status" tone={snapshot ? 'neutral' : statuses[status].tone}><span className="status-dot" />{label}</Badge>;
}

export function Observation({ value }: { value?: string }) {
  return value ? <time dateTime={value}>{formatObservation(value)}</time> : <span>Нет данных</span>;
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="notice" role="alert"><TriangleAlert size={16} aria-hidden="true" /><div>{children}</div></div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const Icon = state === 'copied' ? Check : Copy;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return <div className="copy-control">
    <Button variant="ghost" onClick={() => void copy()} aria-label={label} title={label} className="icon-button">
      <Icon size={16} aria-hidden="true" />
    </Button>
    <span className={state === 'failed' ? 'copy-error' : 'sr-only'} role="status">
      {state === 'copied' ? 'Скопировано' : state === 'failed' ? 'Скопируйте вручную.' : ''}
    </span>
  </div>;
}

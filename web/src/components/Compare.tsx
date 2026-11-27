import { useState } from 'react';
import { ArrowRight, Clock3, Cpu, HardDrive, MemoryStick } from 'lucide-react';
import { Button } from '../aspect/controls';
import { formatBytes, formatPercent, type FleetNode } from '../domain';
import { Observation, Status } from './common';

function CompareNode({ nodes, node, other, label, onSelect, onChoose, snapshot }: {
  nodes: FleetNode[];
  node?: FleetNode;
  other?: FleetNode;
  label: string;
  onSelect: (id: string) => void;
  onChoose: (id: string) => void;
  snapshot: boolean;
}) {
  const current = node?.metrics;
  return <section className="panel compare-card" aria-label={label}>
    <label className="field compare-picker"><span>{label}</span><select className="aspect-input" value={node?.id ?? ''} onChange={event => onSelect(event.target.value)}>
      <option value="">Выберите узел</option>
      {nodes.map(item => <option value={item.id} disabled={item.id === other?.id} key={item.id}>{item.name}</option>)}
    </select></label>
    {node ? <>
      <div className="compare-node"><h2>{node.name}</h2><Status status={node.status} snapshot={snapshot} /></div>
      <dl className="compare-readings">
        <div><dt><Clock3 size={15} aria-hidden="true" /> Сигнал</dt><dd><Observation value={node.last_seen} /></dd></div>
        <div><dt><Cpu size={15} aria-hidden="true" /> CPU</dt><dd>{current ? formatPercent(current.cpu_percent) : '—'}</dd></div>
        <div><dt><MemoryStick size={15} aria-hidden="true" /> Свободно RAM</dt><dd>{current ? formatBytes(Math.max(0, current.memory_total_bytes - current.memory_used_bytes)) : '—'}</dd></div>
        <div><dt><HardDrive size={15} aria-hidden="true" /> Свободно на диске</dt><dd>{current ? formatBytes(Math.max(0, current.disk_total_bytes - current.disk_used_bytes)) : '—'}</dd></div>
      </dl>
      <Button variant="ghost" className="compare-open" onClick={() => onChoose(node.id)}>Открыть узел <ArrowRight size={15} aria-hidden="true" /></Button>
    </> : <p className="compare-placeholder">{nodes.length > 1 ? 'Выберите узел, чтобы сравнить снимки.' : 'Подключите ещё один узел для сравнения.'}</p>}
  </section>;
}

export function Compare({ nodes, onChoose, onFleet, snapshot }: { nodes: FleetNode[]; onChoose: (id: string) => void; onFleet: () => void; snapshot: boolean }) {
  const [firstId, setFirst] = useState<string>();
  const [secondId, setSecond] = useState<string>();
  const first = firstId === '' ? undefined : nodes.find(node => node.id === firstId) ?? nodes[0];
  const rest = nodes.filter(node => node.id !== first?.id);
  const second = secondId === '' ? undefined : rest.find(node => node.id === secondId) ?? rest[0];

  return <section className="fleet" aria-labelledby="fleet-heading">
    <div className="view-heading"><div><h1 id="fleet-heading" tabIndex={-1}>Мультиконсоль</h1><p>{snapshot ? 'Последние доступные снимки узлов.' : 'Сравнение последних снимков двух узлов.'}</p></div>
      <Button onClick={onFleet}>К списку узлов <ArrowRight size={16} aria-hidden="true" /></Button></div>
    <div className="compare-grid">
      <CompareNode nodes={nodes} node={first} other={second} label="Левая панель" onSelect={setFirst} onChoose={onChoose} snapshot={snapshot} />
      <CompareNode nodes={nodes} node={second} other={first} label="Правая панель" onSelect={setSecond} onChoose={onChoose} snapshot={snapshot} />
    </div>
  </section>;
}

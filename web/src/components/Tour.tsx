import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { Button } from '../aspect/controls';
import './tour.css';

type TourView = 'fleet' | 'assistant' | 'guide' | 'settings';
type TourStep = { view: TourView; target: string; title: string; detail: string };
export type TourId = 'vps' | 'agent' | 'connections';

export const tours = {
  vps: {
    label: 'Подключить VPS', detail: 'Регистрация сборщика и первый сигнал.',
    steps: [
      { view: 'fleet', target: 'fleet-enroll', title: 'Зарегистрируйте узел', detail: 'Кнопка открывает форму регистрации. После неё Caudal выдаст архитектурные команды и токен для сборщика Linux.' },
      { view: 'fleet', target: 'fleet-list', title: 'Найдите первый сигнал', detail: 'Сохраните токен на VPS и запустите сборщик. В списке появится время сигнала. Нажмите имя узла, чтобы открыть историю метрик.' },
    ],
  },
  agent: {
    label: 'Работа с агентом', detail: 'Выбор модели, запрос и подтверждение.',
    steps: [
      { view: 'assistant', target: 'assistant-provider', title: 'Выберите источник ответа', detail: 'Локальная сводка использует метрики Caudal. DeepSeek доступен, когда настроен ключ API.' },
      { view: 'assistant', target: 'assistant-composer', title: 'Опишите задачу', detail: 'Спросите о нагрузке, свежести метрик или проверке доступности. Caudal покажет данные и запросит разрешение, если нужно запустить операцию.' },
      { view: 'settings', target: 'settings-approval', title: 'Настройте подтверждения', detail: 'Можно включить автоматическое подтверждение чтения. Каждый запрос на изменение потребует вашего согласия.' },
    ],
  },
  connections: {
    label: 'Подключения', detail: 'Профили, история и сравнение сигналов.',
    steps: [
      { view: 'guide', target: 'connections-tabs', title: 'Выберите проверку', detail: 'Здесь доступны разрешённые операции, сравнение доставки сигналов и история измерений.' },
      { view: 'guide', target: 'connections-catalog', title: 'Посмотрите каталог операций', detail: 'Операции привязаны к настроенным целям. Каталог показывает транспорт и какие действия потребуют подтверждения.' },
      { view: 'guide', target: 'connections-teleport', title: 'Проверьте доступность прокси', detail: 'Веб-проверка Teleport наблюдает DNS, TLS и HTTP из сети Caudal. Вход и права на нужном хосте проверяются в Teleport.' },
    ],
  },
} as const satisfies Record<TourId, { label: string; detail: string; steps: readonly TourStep[] }>;

export type TourPosition = { id: TourId; index: number };
type Box = { left: number; top: number; width: number; height: number };
type Geometry = { panel: Box; target?: Box; edge?: 'top' | 'bottom'; arrow?: number };

function clamp(number: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(number, maximum));
}

function calculate(viewport: Box, anchor: DOMRect | undefined, height: number): Geometry {
  const gutter = 12;
  const gap = 13;
  const width = Math.min(356, viewport.width - gutter * 2);
  const panel = {
    left: viewport.left + (viewport.width - width) / 2,
    top: viewport.top + Math.max(gutter, (viewport.height - height) / 2),
    width,
    height,
  };
  if (!anchor) return { panel };
  const target = { left: anchor.left - 4, top: anchor.top - 4, width: anchor.width + 8, height: anchor.height + 8 };
  const center = anchor.left + anchor.width / 2;
  const bottom = viewport.top + viewport.height - gutter;
  const below = target.top + target.height + gap;
  const above = target.top - height - gap;
  panel.left = clamp(center - width / 2, viewport.left + gutter, viewport.left + viewport.width - gutter - width);
  const edge = below + height <= bottom ? 'top' : above >= viewport.top + gutter ? 'bottom' : undefined;
  panel.top = edge === 'top' ? below : edge === 'bottom' ? above : clamp(below, viewport.top + gutter, bottom - height);
  return { panel, target, edge, arrow: clamp(center - panel.left, 16, width - 16) };
}

function viewportBox(): Box {
  const viewport = window.visualViewport;
  return {
    left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
  };
}

export function Tour({ position, onStep, onClose }: {
  position: TourPosition;
  onStep: (position: TourPosition) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [geometry, setGeometry] = useState<Geometry>();
  const sequence = tours[position.id].steps;
  const step = sequence[position.index];
  const last = position.index === sequence.length - 1;

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);

  useLayoutEffect(() => {
    const tooltip = panel.current;
    if (!tooltip) return;
    const anchor = document.querySelector(`[data-tour="${step.target}"]`);
    const visibleAnchor = () => {
      const rect = anchor?.getBoundingClientRect();
      return rect?.width && rect.height ? rect : undefined;
    };
    const rect = visibleAnchor();
    const viewport = viewportBox();
    const top = viewport.top + 15;
    const bottom = viewport.top + viewport.height - 80;
    if (rect && (rect.top < top || rect.bottom > bottom)) anchor?.scrollIntoView({ block: 'center', behavior: 'instant' });
    let frame = 0;
    function positionTooltip() {
      const nextViewport = viewportBox();
      const height = Math.min(tooltip?.offsetHeight ?? 0, nextViewport.height - 24);
      setGeometry(calculate(nextViewport, visibleAnchor(), height));
    }
    function schedule() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(positionTooltip);
    }
    positionTooltip();
    heading.current?.focus({ preventScroll: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(tooltip);
    if (anchor) resize.observe(anchor);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [step]);

  return <dialog ref={dialog} className="tour-overlay" data-anchored={Boolean(geometry?.target)} aria-labelledby="tour-title" aria-describedby="tour-detail"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    {geometry?.target && <div className="tour-spotlight" style={geometry.target} aria-hidden="true" />}
    <div ref={panel} className="tour-popover" data-edge={geometry?.edge} style={geometry ? { width: geometry.panel.width, left: geometry.panel.left, top: geometry.panel.top } : undefined}>
      {geometry?.edge && <span aria-hidden="true" className="tour-pointer" style={{ left: geometry.arrow }} />}
      <div className="tour-content">
        <div className="tour-meta"><span>Шаг {position.index + 1} из {sequence.length}</span>
          <Button variant="ghost" className="icon-button" aria-label="Закрыть подсказку" onClick={onClose}><X size={18} aria-hidden="true" /></Button></div>
        <h2 ref={heading} id="tour-title" tabIndex={-1}>{step.title}</h2>
        <p id="tour-detail">{step.detail}</p>
        <div className="tour-actions">
          <Button variant="ghost" disabled={position.index === 0} onClick={() => onStep({ ...position, index: position.index - 1 })}><ArrowLeft size={15} aria-hidden="true" /> Назад</Button>
          <Button variant="primary" onClick={last ? onClose : () => onStep({ ...position, index: position.index + 1 })}>{last ? 'Готово' : 'Далее'}{!last && <ArrowRight size={15} aria-hidden="true" />}</Button>
        </div>
      </div>
    </div>
  </dialog>;
}

export type NodeStatus = 'healthy' | 'stale' | 'pending';
export type Metrics = {
  cpu_percent: number;
  memory_used_bytes: number;
  memory_total_bytes: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  uptime_seconds: number;
};
export type FleetNode = {
  id: string;
  name: string;
  region: string;
  created_at: string;
  last_seen?: string;
  status: NodeStatus;
  metrics?: Metrics;
};
export type Sample = { observed_at: string; metrics: Metrics };
export type Evidence = {
  node_id: string;
  name: string;
  status: NodeStatus;
  observed_at?: string;
};
export type AssistantMode = 'local' | 'deepseek';
export type AssistantReply = { answer: string; source: AssistantMode; evidence: Evidence[] };
export type TeleportProfile = {
  id: string;
  label: string;
  web_url: string;
  status: 'reachable' | 'unreachable' | 'not_checked';
  checked_at?: string;
  latency_ms?: number;
  error?: string;
  version?: string;
};
export type Enrollment = { node: FleetNode; token: string };
export type Architecture = 'amd64' | 'arm64';

export const statuses = {
  healthy: { label: 'На связи', tone: 'success' },
  stale: { label: 'Данные устарели', tone: 'warning' },
  pending: { label: 'Ожидает данные', tone: 'neutral' },
} as const;

const clock = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' });
const calendar = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const decimal = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 });

export function formatObservation(value?: string) {
  if (!value) return 'Нет данных';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Нет данных';
  return `${calendar.format(date)}, ${clock.format(date)} UTC`;
}

export function formatBytes(value: number) {
  const units = ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ'];
  const index = value < 1 ? 0 : Math.min(Math.floor(Math.log2(value) / 10), units.length - 1);
  return `${decimal.format(value / 1024 ** index)} ${units[index]}`;
}

export function formatPercent(value: number) {
  return `${decimal.format(value)}%`;
}

export function ratio(used: number, total: number) {
  return total > 0 ? Math.min(100, Math.max(0, 100 * used / total)) : 0;
}

export function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds / 3_600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  if (days > 0) return `${days} д ${hours} ч`;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  return `${minutes} мин`;
}

export function countStatuses(nodes: readonly FleetNode[]) {
  const counts: Record<NodeStatus, number> = { healthy: 0, stale: 0, pending: 0 };
  for (const node of nodes) counts[node.status]++;
  return counts;
}

export function recentSamples(samples: readonly Sample[], limit: number) {
  return samples.toSorted((first, second) => Date.parse(first.observed_at) - Date.parse(second.observed_at)).slice(-limit);
}

export function collectorCommands(origin: string, nodeId: string, architecture: Architecture) {
  const server = new URL(origin).origin;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(nodeId)) throw new Error('Некорректный идентификатор узла');
  const folder = '"$HOME/.config/caudal"';
  const tokenFile = `"$HOME/.config/caudal/${nodeId}.token"`;
  const binary = '"$HOME/.config/caudal/caudal-agent"';
  return {
    download: `install -d -m 700 ${folder}\ncurl -fsSL '${server}/downloads/caudal-agent-linux-${architecture}' -o ${binary}\nchmod 700 ${binary}`,
    configure: `bash -c 'umask 077; read -rsp "Collector token: " token || exit; printf "%s\\n" "$token" > "$1" || exit; chmod 600 "$1" || exit; printf "\\n"' _ ${tokenFile}`,
    start: `CAUDAL_URL='${server}' CAUDAL_TOKEN_FILE=${tokenFile} ${binary}`,
  };
}

import type { AssistantReply, Enrollment, FleetNode, Sample } from './domain';

const errorMessages: Record<string, string> = {
  authentication_required: 'Сеанс завершён. Войдите снова.',
  invalid_password: 'Неверный пароль.',
  too_many_attempts: 'Слишком много попыток. Повторите через минуту.',
  too_many_sessions: 'Достигнут предел активных сеансов.',
  node_not_found: 'Узел не найден.',
  invalid_node_data: 'Проверьте имя и регион узла.',
  fleet_limit_reached: 'Достигнут предел числа узлов.',
  storage_error: 'Хранилище временно недоступно.',
  deepseek_not_configured: 'Добавьте ключ DeepSeek в настройках ассистента.',
  deepseek_key_rejected: 'DeepSeek не принял ключ API. Проверьте его в настройках ассистента.',
  deepseek_unavailable: 'DeepSeek временно недоступен.',
  deepseek_busy: 'DeepSeek занят. Повторите запрос позже.',
  assistant_busy: 'Ассистент обрабатывает другие запросы. Повторите позже.',
  invalid_assistant_input: 'Проверьте вопрос и ключ DeepSeek.',
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(endpoint: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${endpoint}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...options,
      headers: { Accept: 'application/json', ...options?.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'Не удалось связаться с Caudal. Проверьте подключение.');
  }
  if (!response.ok) {
    const body: { error?: unknown } | null = await response.json().catch(() => null);
    const code = typeof body?.error === 'string' ? body.error : '';
    const message = Object.hasOwn(errorMessages, code) ? errorMessages[code] : 'Запрос не выполнен.';
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function post<T>(endpoint: string, body: object, signal?: AbortSignal) {
  return request<T>(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    signal,
  });
}

type Session = { authenticated: boolean };

export const api = {
  session: (signal?: AbortSignal) => request<Session>('/session', { signal }),
  login: (password: string) => post<Session>('/session', { password }),
  logout: () => request<void>('/session', { method: 'DELETE' }),
  fleet: (signal?: AbortSignal) => request<{ nodes: FleetNode[] }>('/fleet', { signal }),
  enroll: (name: string, region: string, signal?: AbortSignal) => post<Enrollment>('/nodes', { name, region }, signal),
  rotate: (nodeId: string, signal?: AbortSignal) => request<{ token: string }>(`/nodes/${encodeURIComponent(nodeId)}/rotate`, { method: 'POST', signal }),
  samples: (nodeId: string, signal?: AbortSignal) => request<{ samples: Sample[] }>(`/nodes/${encodeURIComponent(nodeId)}/samples`, { signal }),
  ask: (message: string, nodeId: string | undefined, apiKey: string | undefined, signal?: AbortSignal) =>
    post<AssistantReply>('/assistant', { message, node_id: nodeId, api_key: apiKey }, signal),
};

export function apiUrl(path: string): string {
  return `/api${path}`;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: 'same-origin',
    signal: init.signal ?? AbortSignal.timeout(1500),
    headers: { 'Content-Type': 'application/json', 'X-ROVSSA-Request': '1', ...init.headers },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response;
}

// The app's API, from the browser. Changes send JSON: the server refuses anything else (a form post from another site).
export interface User { id: string; email: string | null; name: string | null }
export interface Note { id: string; title: string; created_at: string }

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null; error?: string }> {
  const res = await fetch(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => null) as (T & { error?: { message?: string } }) | null;
  return { status: res.status, data: res.ok ? json : null, error: res.ok ? undefined : json?.error?.message ?? `Request failed (${res.status})` };
}

export const api = {
  me: () => call<{ user: User }>('GET', '/api/me'),
  notes: () => call<Note[]>('GET', '/api/notes'),
  add: (title: string) => call<Note>('POST', '/api/notes', { title }),
  signOut: () => call<{ ok: true }>('POST', '/auth/sign-out', {}),
};

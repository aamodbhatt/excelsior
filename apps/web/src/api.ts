import type { WorkbookDoc } from '@excelsior/doc';

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface WorkbookMeta {
  id: string;
  title: string;
  version: number;
  updatedAt: number;
  role: 'owner' | 'editor' | 'viewer';
}

export interface VersionEntry {
  version: number;
  userName: string | null;
  summary: string;
  createdAt: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText);
  return json as T;
}

export const api = {
  me: () => call<{ user: User }>('GET', '/api/auth/me'),
  signup: (email: string, name: string, password: string) =>
    call<{ user: User }>('POST', '/api/auth/signup', { email, name, password }),
  login: (email: string, password: string) =>
    call<{ user: User }>('POST', '/api/auth/login', { email, password }),
  logout: () => call('POST', '/api/auth/logout', {}),
  list: () => call<{ workbooks: WorkbookMeta[] }>('GET', '/api/workbooks'),
  create: (title: string, template: 'blank' | 'neural-net' | 'transformer') =>
    call<{ id: string }>('POST', '/api/workbooks', { title, template }),
  get: (id: string) => call<{ workbook: WorkbookMeta }>('GET', `/api/workbooks/${id}`),
  share: (id: string, role: 'editor' | 'viewer') =>
    call<{ token: string }>('POST', `/api/workbooks/${id}/shares`, { role }),
  acceptShare: (token: string) => call<{ workbookId: string }>('POST', `/api/shares/${token}/accept`, {}),
  versions: (id: string) =>
    call<{ current: number; versions: VersionEntry[] }>('GET', `/api/workbooks/${id}/versions`),
  versionDoc: (id: string, v: number) =>
    call<{ doc: WorkbookDoc; version: number }>('GET', `/api/workbooks/${id}/versions/${v}`),
  restore: (id: string, version: number) => call('POST', `/api/workbooks/${id}/restore`, { version }),
  remove: (id: string) => call('DELETE', `/api/workbooks/${id}`),
};

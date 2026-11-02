/**
 * 后台 UI 的接口层。
 *
 * token 存 localStorage（后台只跑在管理员自己的浏览器上，且是短期的 access token +
 * 可吊销的 refresh token）；401 时自动用 refresh token 换一次，换不到就回登录页。
 */

const TOKEN_KEY = "wp.admin.token";
const REFRESH_KEY = "wp.admin.refresh";

export interface AdminUser {
  id: number;
  username: string;
  role: "admin" | "user";
  createdAt: number;
  lastLoginAt: number | null;
  trackCount?: number;
  usedBytes?: number;
}

export interface Overview {
  users: number;
  disabledUsers: number;
  tracks: number;
  libraryBytes: number;
  trashCount: number;
  diskBytes: number;
  cursor: number;
  serverName: string;
  registrationOpen: boolean;
  inviteRequired: boolean;
  quotaBytes: number;
}

export interface CloudTrack {
  hash: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  size: number;
  ext: string;
  codec: string;
  hasCover: boolean;
  hasLyrics: boolean;
  createdAt: number;
  userId?: number;
  username?: string;
}

export interface Invite {
  code: string;
  createdAt: number;
  usedBy: string | null;
  usedAt: number | null;
}

export const session = {
  get token(): string {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  },
  get refreshToken(): string {
    return localStorage.getItem(REFRESH_KEY) ?? "";
  },
  set(token: string, refreshToken: string): void {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(REFRESH_KEY, refreshToken);
  },
  update(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
  },
  clear(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function tryRefresh(): Promise<boolean> {
  const refreshToken = session.refreshToken;
  if (!refreshToken) return false;
  const response = await fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken, device: "admin-ui" }),
  });
  if (!response.ok) {
    session.clear();
    return false;
  }
  const data = (await response.json()) as { token: string; refreshToken: string };
  session.set(data.token, data.refreshToken);
  return true;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  allowRetry = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (session.token) headers.set("Authorization", `Bearer ${session.token}`);
  if (init.body && !(init.body instanceof Blob) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, { ...init, headers });
  if (response.status === 401 && allowRetry && (await tryRefresh())) {
    return request<T>(path, init, false);
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new ApiError(data?.error ?? `HTTP ${response.status}`, response.status);
  }
  return data as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ token: string; refreshToken: string; user: AdminUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password, device: "admin-ui" }),
    }),

  me: () => request<{ user: AdminUser; server: { name: string } }>("/api/auth/me"),

  overview: () => request<Overview>("/api/admin/overview"),

  users: () => request<{ users: AdminUser[] }>("/api/admin/users"),
  createUser: (username: string, password: string, role: string) =>
    request<{ user: AdminUser }>("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ username, password, role }),
    }),
  updateUser: (id: number, patch: Record<string, unknown>) =>
    request<{ user: AdminUser }>(`/api/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteUser: (id: number) => request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: "DELETE" }),

  settings: () =>
    request<{
      serverName: string;
      registrationOpen: boolean;
      inviteRequired: boolean;
      quotaBytes: number;
      maxUploadBytes: number;
    }>("/api/admin/settings"),
  saveSettings: (patch: Record<string, unknown>) =>
    request<{ serverName: string; registrationOpen: boolean; inviteRequired: boolean }>(
      "/api/admin/settings",
      { method: "PATCH", body: JSON.stringify(patch) },
    ),

  invites: () => request<{ invites: Invite[] }>("/api/admin/invites"),
  createInvites: (count: number) =>
    request<{ created: string[] }>("/api/admin/invites", {
      method: "POST",
      body: JSON.stringify({ count }),
    }),
  deleteInvite: (code: string) =>
    request<{ ok: boolean }>(`/api/admin/invites/${encodeURIComponent(code)}`, { method: "DELETE" }),

  tracks: (params: { userId?: number; q?: string; limit?: number; offset?: number }) => {
    const search = new URLSearchParams();
    if (params.userId) search.set("userId", String(params.userId));
    if (params.q) search.set("q", params.q);
    search.set("limit", String(params.limit ?? 100));
    search.set("offset", String(params.offset ?? 0));
    return request<{ total: number; tracks: CloudTrack[] }>(`/api/admin/tracks?${search}`);
  },
  deleteTrack: (userId: number, hash: string) =>
    request<{ ok: boolean }>(`/api/admin/tracks/${userId}/${hash}`, { method: "DELETE" }),
  purgeTrash: () => request<{ removed: number }>("/api/admin/trash/purge", { method: "POST" }),
  gc: () => request<{ removed: number; freedBytes: number }>("/api/admin/gc", { method: "POST" }),
  checkpoint: () => request<{ ok: boolean; dbBytes: number }>("/api/admin/checkpoint", {
    method: "POST",
  }),

  /** 上传音频（后台批量入库用）：直接 PUT 原始字节，进度靠 XHR */
  upload: (
    file: File,
    onProgress?: (ratio: number) => void,
  ) =>
    new Promise<{ track: CloudTrack; duplicate: boolean }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/tracks/upload?filename=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader("Authorization", `Bearer ${session.token}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded / event.total);
      };
      xhr.onload = () => {
        let payload: { track?: CloudTrack; duplicate?: boolean; error?: string } = {};
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          /* 忽略 */
        }
        if (xhr.status >= 200 && xhr.status < 300 && payload.track) {
          resolve({ track: payload.track, duplicate: Boolean(payload.duplicate) });
        } else {
          reject(new ApiError(payload.error ?? `HTTP ${xhr.status}`, xhr.status));
        }
      };
      xhr.onerror = () => reject(new ApiError("网络错误", 0));
      xhr.send(file);
    }),
};

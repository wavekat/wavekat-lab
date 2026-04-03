import { getAccessToken, clearAuth } from "./auth";

const API_BASE = import.meta.env.VITE_API_URL || "";

export interface Clip {
  id: string;
  sentence: string;
  audio_url: string;
  word_count: number;
  char_count: number;
  gender: string;
  age: string;
  accent: string;
  up_votes: number;
  down_votes: number;
}

export interface Dataset {
  id: string;
  dataset_id: string;
  version: string;
  locale: string;
  split: string;
  clip_count: number;
  size_bytes: number;
  status: "synced" | "syncing" | "failed";
  synced_at: string | null;
}

export interface ClipsResponse {
  clips: Clip[];
  total: number;
  offset: number;
  limit: number;
}

export interface Filters {
  version?: string;
  locale: string;
  split: string;
  q?: string;
  min_words?: number;
  max_words?: number;
  gender?: string;
  age?: string;
  has_audio?: string;
  sort?: string;
  order?: string;
}

export async function authFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const token = await getAccessToken();
  if (!token) {
    clearAuth();
    window.location.href = "/";
    throw new Error("unauthorized");
  }

  const res = await fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401) {
    clearAuth();
    window.location.href = "/";
    throw new Error("unauthorized");
  }

  return res;
}

export async function fetchDatasets(): Promise<Dataset[]> {
  const res = await authFetch(`${API_BASE}/api/datasets`);
  if (!res.ok) throw new Error("Failed to fetch datasets");
  const data = (await res.json()) as { datasets: Dataset[] };
  return data.datasets;
}

export async function fetchClips(
  filters: Filters,
  offset = 0,
  limit = 50,
): Promise<ClipsResponse> {
  const params = new URLSearchParams();
  if (filters.version) params.set("version", filters.version);
  params.set("locale", filters.locale);
  params.set("split", filters.split);
  if (filters.q) params.set("q", filters.q);
  if (filters.min_words !== undefined)
    params.set("min_words", String(filters.min_words));
  if (filters.max_words !== undefined)
    params.set("max_words", String(filters.max_words));
  if (filters.gender) params.set("gender", filters.gender);
  if (filters.age) params.set("age", filters.age);
  if (filters.has_audio) params.set("has_audio", filters.has_audio);
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.order) params.set("order", filters.order);
  params.set("offset", String(offset));
  params.set("limit", String(limit));

  const res = await authFetch(`${API_BASE}/api/clips?${params}`);
  if (!res.ok) throw new Error("Failed to fetch clips");
  return res.json() as Promise<ClipsResponse>;
}

export function audioUrl(path: string): string {
  return `${API_BASE}${path}`;
}

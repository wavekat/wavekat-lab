const API_BASE = import.meta.env.VITE_API_URL || "";

export interface AuthUser {
  sub: string;
  github_id: number;
  username: string;
  avatar_url?: string;
  terms_accepted: boolean;
}

function storeTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem("cv_access_token", accessToken);
  localStorage.setItem("cv_refresh_token", refreshToken);
}

export function clearAuth() {
  localStorage.removeItem("cv_access_token");
  localStorage.removeItem("cv_refresh_token");
}

function decodeJWT(token: string): AuthUser | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload.exp * 1000 < Date.now()) return null;
    return payload as AuthUser;
  } catch {
    return null;
  }
}

let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const rt = localStorage.getItem("cv_refresh_token");
  if (!rt) {
    clearAuth();
    return null;
  }

  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: rt }),
    });

    if (!res.ok) {
      clearAuth();
      return null;
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
    };
    storeTokens(data.access_token, data.refresh_token);
    return data.access_token;
  } catch {
    clearAuth();
    return null;
  }
}

export async function getAccessToken(): Promise<string | null> {
  const token = localStorage.getItem("cv_access_token");
  if (token) {
    try {
      const raw = JSON.parse(atob(token.split(".")[1]));
      if (raw.exp * 1000 - Date.now() > 5 * 60 * 1000) {
        return token;
      }
    } catch {
      // fall through to refresh
    }
  }

  // Deduplicate concurrent refresh calls
  if (!refreshPromise) {
    refreshPromise = refreshAccessToken().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function login(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/auth/config`);
  const { github_client_id } = (await res.json()) as {
    github_client_id: string;
  };
  const redirectUri = `${window.location.origin}/auth/callback`;
  window.location.href = `https://github.com/login/oauth/authorize?client_id=${github_client_id}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

export async function handleCallback(code: string): Promise<AuthUser> {
  const redirectUri = `${window.location.origin}/auth/callback`;
  const res = await fetch(`${API_BASE}/api/auth/github`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });

  if (!res.ok) throw new Error("Authentication failed");

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    user: { terms_accepted: boolean };
  };
  storeTokens(data.access_token, data.refresh_token);
  return decodeJWT(data.access_token)!;
}

export async function acceptTerms(): Promise<AuthUser> {
  const token = await getAccessToken();
  if (!token) throw new Error("Not authenticated");

  const res = await fetch(`${API_BASE}/api/auth/terms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) throw new Error("Failed to accept terms");

  const data = (await res.json()) as { access_token: string };
  localStorage.setItem("cv_access_token", data.access_token);
  return decodeJWT(data.access_token)!;
}

export async function logout(): Promise<void> {
  const refreshToken = localStorage.getItem("cv_refresh_token");
  const token = localStorage.getItem("cv_access_token");

  if (refreshToken && token) {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch {
      // Ignore logout errors
    }
  }

  clearAuth();
}

export async function initAuth(): Promise<AuthUser | null> {
  const token = await getAccessToken();
  if (!token) return null;
  return decodeJWT(token);
}

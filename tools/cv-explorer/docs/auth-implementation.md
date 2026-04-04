# WaveKat Lab — Common Voice Explorer: Authentication & Terms Acceptance

## Motivation

Common Voice's usage terms prohibit **re-hosting** and **re-sharing** the dataset.
Common Voice Explorer currently serves all data (audio + metadata) publicly with no access control,
which constitutes re-hosting.

To stay compliant while keeping the tool useful, we add:

1. **GitHub OAuth login** — every user must authenticate
2. **Terms acceptance gate** — users must agree to Common Voice terms before accessing data
3. **Token-protected API** — all endpoints (including audio) require a valid token

After these changes, Common Voice Explorer becomes a **private review tool** rather than a public
dataset mirror.

---

## Branding

- **Product**: [WaveKat Lab](https://github.com/wavekat/wavekat-lab) — a web-based
  experimentation tool by [WaveKat](https://wavekat.com)
- **This tool**: Common Voice Explorer — a standalone tool within the `tools/cv-explorer/` directory,
  deployed independently on Cloudflare
- **Display name in UI**: "Common Voice Explorer" with WaveKat Lab attribution in header/footer
  (consistent with the main wavekat-lab app's branding pattern)
- **GitHub OAuth App name**: "WaveKat Lab — Common Voice Explorer"
- **Terms page**: branded as WaveKat Lab's terms, referencing Common Voice's upstream license

---

## Architecture Overview

```
┌─────────────┐     ┌──────────────────────────────────────────────┐
│  Browser     │     │  Cloudflare Worker                           │
│             │     │                                              │
│  1. Click   │────▶│  GET /api/auth/github?code=xxx               │
│  "Login w/  │     │    ├─ Exchange code with GitHub               │
│   GitHub"   │◀────│    ├─ Upsert user in D1                      │
│             │     │    └─ Return JWT (access) + refresh token     │
│  2. Accept  │────▶│                                              │
│  terms      │     │  POST /api/auth/terms                        │
│             │◀────│    └─ Record acceptance, return updated JWT   │
│             │     │                                              │
│  3. Use app │────▶│  GET /api/clips   ┐                          │
│  (all reqs  │     │  GET /api/audio/* ├─ auth middleware          │
│   carry JWT)│◀────│  GET /api/datasets┘  ├─ verify JWT            │
│             │     │                      ├─ check terms_accepted  │
│             │     │                      └─ reject if invalid     │
└─────────────┘     └──────────────────────────────────────────────┘
```

---

## Database Changes

New migration: `0002_auth.sql`

```sql
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,   -- ulid
  github_id       INTEGER NOT NULL UNIQUE,
  username        TEXT NOT NULL,
  avatar_url      TEXT,
  terms_accepted  INTEGER DEFAULT 0,  -- 0 = not accepted, 1 = accepted
  terms_version   TEXT,               -- version string of accepted terms
  terms_accepted_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT PRIMARY KEY,       -- ulid
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL,          -- sha256 hash, never store raw
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
```

Key decisions:
- `terms_accepted` lives on the `users` table (simple boolean) — no separate table needed
- Refresh tokens are hashed before storage
- No session table — JWTs are stateless

---

## Worker Changes

### New Environment Bindings

Add to `wrangler.toml`:

```toml
[vars]
GITHUB_CLIENT_ID = "..."
GITHUB_REDIRECT_URI = "https://commonvoice-explorer.wavekat.com/auth/callback"
TERMS_VERSION = "cv-2024-12"

# Set via `wrangler secret put`:
# GITHUB_CLIENT_SECRET
# JWT_SECRET
```

Update `Env` type in `index.ts`:

```ts
export type Env = {
  Bindings: {
    DB: D1Database;
    AUDIO: R2Bucket;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    GITHUB_REDIRECT_URI: string;
    JWT_SECRET: string;
    TERMS_VERSION: string;
  };
};
```

### Auth Middleware

New file: `src/middleware/auth.ts`

```ts
import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";
import type { Env } from "../index";

export type AuthUser = {
  sub: string;        // user id
  github_id: number;
  username: string;
  terms_accepted: boolean;
};

// Verify JWT and attach user to context
export const auth = createMiddleware<Env>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const token = header.slice(7);
  try {
    const payload = await verify(token, c.env.JWT_SECRET) as AuthUser;
    c.set("user", payload);
  } catch {
    return c.json({ error: "invalid_token" }, 401);
  }

  await next();
});

// Require terms acceptance (use after auth middleware)
export const requireTerms = createMiddleware<Env>(async (c, next) => {
  const user = c.get("user") as AuthUser;
  if (!user.terms_accepted) {
    return c.json({ error: "terms_not_accepted" }, 403);
  }
  await next();
});
```

### New Routes

#### `src/routes/auth.ts` — GitHub OAuth + Token Management

```ts
// POST /api/auth/github  { code: string }
//   → Exchange GitHub OAuth code for access token
//   → Fetch GitHub user profile
//   → Upsert user in D1
//   → Return { access_token (JWT, 1h), refresh_token (opaque, 30d), user }

// POST /api/auth/refresh  { refresh_token: string }
//   → Validate refresh token against D1 (hashed)
//   → Issue new access_token + rotate refresh_token
//   → Delete old refresh token

// POST /api/auth/terms
//   → Requires auth middleware
//   → Update user.terms_accepted = 1, terms_version, terms_accepted_at
//   → Return new JWT with terms_accepted = true

// GET /api/auth/me
//   → Requires auth middleware
//   → Return current user info from JWT (no DB query)

// POST /api/auth/logout
//   → Delete refresh token from D1
```

#### JWT Payload

```ts
{
  sub: "user_id",
  github_id: 12345,
  username: "octocat",
  terms_accepted: true,
  iat: 1234567890,
  exp: 1234571490   // 1 hour
}
```

### Updated Route Registration

```ts
// src/index.ts
import { auth, requireTerms } from "./middleware/auth";
import { authRoute } from "./routes/auth";

const app = new Hono<Env>();

app.use("/api/*", cors());

// Public: auth endpoints
app.route("/api/auth", authRoute);

// Protected: all data endpoints require auth + terms
app.use("/api/clips/*", auth, requireTerms);
app.use("/api/audio/*", auth, requireTerms);
app.use("/api/datasets/*", auth, requireTerms);
app.use("/api/stats/*", auth, requireTerms);

app.route("/api", clipsRoute);
app.route("/api", audioRoute);
app.route("/api", datasetsRoute);
```

---

## Frontend Changes

### Auth State Management

New file: `src/lib/auth.ts`

```ts
// Token storage: localStorage
//   access_token  — JWT, short-lived (1h)
//   refresh_token — opaque, long-lived (30d)

// Core functions:
//   login()           — redirect to GitHub OAuth
//   handleCallback()  — exchange code, store tokens
//   logout()          — clear tokens, call /api/auth/logout
//   getAccessToken()  — return token, auto-refresh if expired
//   isLoggedIn()      — check if tokens exist
//   getUser()         — decode JWT payload (no API call)

// Auto-refresh logic:
//   Before each API call, check if JWT expires in < 5 min
//   If so, call /api/auth/refresh first
```

### Updated API Client

```ts
// src/lib/api.ts — add Authorization header to all requests

async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken(); // auto-refreshes if needed
  const res = await fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401) {
    // Token invalid — redirect to login
    logout();
    window.location.href = "/";
    throw new Error("unauthorized");
  }

  if (res.status === 403) {
    // Terms not accepted — handled by UI
    throw new Error("terms_not_accepted");
  }

  return res;
}
```

### New UI Components

#### Login Page (`src/components/LoginPage.tsx`)

Shown when user is not authenticated.

```
┌─────────────────────────────────────────┐
│                                         │
│           Common Voice Explorer                   │
│           by WaveKat Lab                │
│                                         │
│   Browse and review Common Voice        │
│   audio clips with rich filtering.      │
│                                         │
│   ┌─────────────────────────────────┐   │
│   │  Sign in with GitHub            │   │
│   └─────────────────────────────────┘   │
│                                         │
│           wavekat.com                   │
└─────────────────────────────────────────┘
```

#### Terms Acceptance (`src/components/TermsGate.tsx`)

Shown after login if `terms_accepted === false`. Must be accepted before any data
is accessible.

```
┌─────────────────────────────────────────────────┐
│                                                 │
│  Common Voice Explorer — Usage Terms                      │
│                                                 │
│  This tool provides access to data from the     │
│  Mozilla Common Voice project. By using         │
│  Common Voice Explorer, you agree to the following:       │
│                                                 │
│  1. You will NOT attempt to determine the       │
│     identity of any speaker in the dataset.     │
│                                                 │
│  2. You will NOT re-distribute, re-host, or     │
│     share any data obtained through this tool.  │
│                                                 │
│  3. Data accessed through this tool is for      │
│     personal or team review purposes only.      │
│                                                 │
│  4. You acknowledge that the underlying data    │
│     is licensed under CC-0 (text) and           │
│     CC-BY 4.0 (audio) by Mozilla Common Voice.  │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │  I Agree                                │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│  Provided by WaveKat Lab · wavekat.com          │
└─────────────────────────────────────────────────┘
```

#### Auth Callback Page (`src/components/AuthCallback.tsx`)
- Handles `/auth/callback?code=xxx` redirect from GitHub
- Exchanges code via `POST /api/auth/github`
- Stores tokens, redirects to app

### Updated App Flow

```tsx
// src/App.tsx
function App() {
  const { user, loading } = useAuth();

  if (loading) return <Spinner />;
  if (!user) return <LoginPage />;
  if (!user.terms_accepted) return <TermsGate />;

  return <Explorer />; // existing app content
}
```

### Header / Footer Branding

The existing app header shows "CV Dataset Explorer". Update to match WaveKat Lab's
branding pattern (see `frontend/src/App.tsx` for the main app's style):

- **Header**: "Common Voice Explorer" title + user avatar/logout on the right
- **Footer**: "WaveKat Lab" link to wavekat.com + GitHub repo link
  (same pattern as the main wavekat-lab app's footer)

### Frontend Routing

Add a simple hash-based or path-based route for the OAuth callback:

```
/                    → App (login / terms / explorer)
/auth/callback       → AuthCallback (GitHub redirect target)
```

Use a lightweight approach (check `window.location.pathname`) — no need for a full router.

---

## GitHub OAuth Setup

1. Create a GitHub OAuth App at `https://github.com/settings/developers`
   - **App name**: "WaveKat Lab — Common Voice Explorer"
   - **Homepage URL**: `https://wavekat.com`
   - **Callback URL**: `https://commonvoice-explorer.wavekat.com/auth/callback`
2. Note the Client ID and Client Secret
3. Store in Cloudflare:
   ```sh
   # wrangler.toml (public)
   GITHUB_CLIENT_ID = "Ov23li..."

   # Secrets (via CLI)
   wrangler secret put GITHUB_CLIENT_SECRET
   wrangler secret put JWT_SECRET
   ```

### OAuth Flow Detail

```
Browser                    Worker                    GitHub
  │                          │                         │
  ├─ redirect ──────────────▶│                         │
  │  github.com/login/oauth/ │                         │
  │  authorize?client_id=... │                         │
  │                          │                         │
  │◀── redirect back ────────│                         │
  │  /auth/callback?code=xxx │                         │
  │                          │                         │
  ├─ POST /api/auth/github ─▶│                         │
  │  { code: "xxx" }         ├─ POST /access_token ───▶│
  │                          │  { client_id,           │
  │                          │    client_secret,        │
  │                          │    code }                │
  │                          │◀── { access_token } ────│
  │                          │                         │
  │                          ├─ GET /user ────────────▶│
  │                          │◀── { id, login, ... } ──│
  │                          │                         │
  │◀── { jwt, refresh } ─────│                         │
  │                          │                         │
```

---

## Audio URL Changes

Currently audio URLs are constructed client-side and loaded directly:

```ts
// Before
audioUrl(path) → "/api/audio/en/clips/abc.mp3"
// <audio src={url} />  ← browser fetches directly, no auth header
```

The `<audio>` element cannot send custom headers. Two options:

### Option A: Fetch as Blob (recommended)

```ts
// Fetch audio with auth, convert to blob URL
const res = await authFetch(`/api/audio/${path}`);
const blob = await res.blob();
const blobUrl = URL.createObjectURL(blob);
// <audio src={blobUrl} />
```

Pros: Simple, works with existing audio element, token never exposed in URL.
Cons: Entire file must download before playback starts (acceptable for short CV clips).

### Option B: Short-lived Signed URL

```ts
// GET /api/audio-url/{path} → { url: "/api/audio/{path}?token=xxx&expires=xxx" }
// Worker validates token+expiry on /api/audio/* if query param present
```

Pros: Streaming playback.
Cons: Token in URL (logged, cached), more complex.

**Recommendation: Option A.** Common Voice clips are short (typically < 15s), so blob
fetch is fine.

---

## Security Considerations

- **JWT Secret**: Use a strong random secret (>= 256 bits). Rotate via wrangler secrets.
- **Refresh Token**: Store only the SHA-256 hash in D1. Raw token lives only in the client.
- **CORS**: Keep existing CORS config. The auth flow uses same-origin API calls.
- **Token Expiry**: Access token = 1 hour, refresh token = 30 days.
- **Rate Limiting**: Consider adding Cloudflare rate limiting rules as a separate concern.
- **Audio Cache Headers**: Change from `immutable` (1 year) to `private, no-store` —
  authenticated content should not be cached publicly.

---

## File Summary

### New Files

```
worker/
  migrations/0002_auth.sql
  src/middleware/auth.ts
  src/routes/auth.ts

web/
  src/lib/auth.ts
  src/components/LoginPage.tsx
  src/components/TermsGate.tsx
  src/components/AuthCallback.tsx
```

### Modified Files

```
worker/
  wrangler.toml          — add env vars
  src/index.ts           — add auth middleware + auth routes

web/
  src/App.tsx            — add auth/terms gating, update header/footer branding
  src/lib/api.ts         — add auth headers to all requests
  src/components/AudioPlayer.tsx  — fetch audio as blob
  index.html             — update <title> if needed
```

---

## Implementation Order

1. **Database migration** — `0002_auth.sql`
2. **Worker auth routes** — OAuth exchange, token refresh, terms acceptance
3. **Worker auth middleware** — JWT verification, terms check
4. **Protect existing routes** — apply middleware to clips/audio/datasets
5. **Frontend auth lib** — token storage, auto-refresh, GitHub redirect
6. **Frontend login + terms UI** — login page, terms gate, callback handler
7. **Frontend API client** — add auth headers, handle 401/403
8. **Audio player** — switch to blob fetch
9. **Update audio cache headers** — `private, no-store`
10. **GitHub OAuth App setup** — create app as "WaveKat Lab — Common Voice Explorer", configure secrets

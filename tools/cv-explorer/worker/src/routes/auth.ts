import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import type { Env } from "../index";

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function generateJWT(
  user: {
    id: string;
    github_id: number;
    username: string;
    avatar_url: string | null;
    terms_accepted: boolean;
  },
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: user.id,
      github_id: user.github_id,
      username: user.username,
      avatar_url: user.avatar_url,
      terms_accepted: user.terms_accepted,
      iat: now,
      exp: now + 3600,
    },
    secret,
  );
}

export const authRoute = new Hono<Env>()
  // Public config (returns GitHub client ID for OAuth redirect)
  .get("/config", (c) => {
    return c.json({ github_client_id: c.env.GITHUB_CLIENT_ID });
  })

  // Exchange GitHub OAuth code for tokens
  .post("/github", async (c) => {
    const { code, redirect_uri } = await c.req.json<{
      code: string;
      redirect_uri: string;
    }>();

    // Exchange code for GitHub access token
    const tokenRes = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: c.env.GITHUB_CLIENT_ID,
          client_secret: c.env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri,
        }),
      },
    );

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      error?: string;
    };
    if (!tokenData.access_token) {
      return c.json({ error: "github_oauth_failed" }, 400);
    }

    // Fetch GitHub user profile
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "User-Agent": "WaveKat-Lab-CV-Explorer",
      },
    });

    if (!userRes.ok) {
      return c.json({ error: "github_user_fetch_failed" }, 400);
    }

    const ghUser = (await userRes.json()) as {
      id: number;
      login: string;
      avatar_url: string;
    };

    if (!ghUser.id || !ghUser.login) {
      return c.json({ error: "github_user_invalid" }, 400);
    }

    // Upsert user in D1
    const now = new Date().toISOString();
    const existing = await c.env.DB.prepare(
      "SELECT id, terms_accepted FROM users WHERE github_id = ?",
    )
      .bind(ghUser.id)
      .first<{ id: string; terms_accepted: number }>();

    let userId: string;
    let termsAccepted: boolean;

    if (existing) {
      userId = existing.id;
      termsAccepted = existing.terms_accepted === 1;
      await c.env.DB.prepare(
        "UPDATE users SET username = ?, avatar_url = ?, updated_at = ? WHERE id = ?",
      )
        .bind(ghUser.login, ghUser.avatar_url, now, userId)
        .run();
    } else {
      userId = crypto.randomUUID();
      termsAccepted = false;
      await c.env.DB.prepare(
        "INSERT INTO users (id, github_id, username, avatar_url, terms_accepted, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
      )
        .bind(userId, ghUser.id, ghUser.login, ghUser.avatar_url, now, now)
        .run();
    }

    // Generate JWT + refresh token
    const user = {
      id: userId,
      github_id: ghUser.id,
      username: ghUser.login,
      avatar_url: ghUser.avatar_url,
      terms_accepted: termsAccepted,
    };

    const accessToken = await generateJWT(user, c.env.JWT_SECRET);

    const refreshTokenRaw = crypto.randomUUID();
    const refreshTokenHash = await hashToken(refreshTokenRaw);
    const refreshTokenId = crypto.randomUUID();
    const expiresAt = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    await c.env.DB.prepare(
      "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(refreshTokenId, userId, refreshTokenHash, expiresAt, now)
      .run();

    return c.json({
      access_token: accessToken,
      refresh_token: refreshTokenRaw,
      user: {
        id: userId,
        username: ghUser.login,
        avatar_url: ghUser.avatar_url,
        terms_accepted: termsAccepted,
      },
    });
  })

  // Refresh access token
  .post("/refresh", async (c) => {
    const { refresh_token } = await c.req.json<{ refresh_token: string }>();

    const hash = await hashToken(refresh_token);
    const stored = await c.env.DB.prepare(
      "SELECT rt.id, rt.user_id, rt.expires_at, u.github_id, u.username, u.avatar_url, u.terms_accepted FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE rt.token_hash = ?",
    )
      .bind(hash)
      .first<{
        id: string;
        user_id: string;
        expires_at: string;
        github_id: number;
        username: string;
        avatar_url: string | null;
        terms_accepted: number;
      }>();

    if (!stored || new Date(stored.expires_at) < new Date()) {
      if (stored) {
        await c.env.DB.prepare("DELETE FROM refresh_tokens WHERE id = ?")
          .bind(stored.id)
          .run();
      }
      return c.json({ error: "invalid_refresh_token" }, 401);
    }

    // Rotate: delete old, create new
    await c.env.DB.prepare("DELETE FROM refresh_tokens WHERE id = ?")
      .bind(stored.id)
      .run();

    const user = {
      id: stored.user_id,
      github_id: stored.github_id,
      username: stored.username,
      avatar_url: stored.avatar_url,
      terms_accepted: stored.terms_accepted === 1,
    };

    const accessToken = await generateJWT(user, c.env.JWT_SECRET);

    const newRefreshRaw = crypto.randomUUID();
    const newRefreshHash = await hashToken(newRefreshRaw);
    const newRefreshId = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    await c.env.DB.prepare(
      "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(newRefreshId, stored.user_id, newRefreshHash, expiresAt, now)
      .run();

    return c.json({
      access_token: accessToken,
      refresh_token: newRefreshRaw,
    });
  })

  // Accept terms (requires auth)
  .post("/terms", async (c) => {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: "unauthorized" }, 401);
    }

    let payload: { sub: string; github_id: number; username: string; avatar_url?: string };
    try {
      payload = (await verify(header.slice(7), c.env.JWT_SECRET, "HS256")) as typeof payload;
    } catch {
      return c.json({ error: "invalid_token" }, 401);
    }

    const now = new Date().toISOString();
    await c.env.DB.prepare(
      "UPDATE users SET terms_accepted = 1, terms_version = ?, terms_accepted_at = ?, updated_at = ? WHERE id = ?",
    )
      .bind(c.env.TERMS_VERSION, now, now, payload.sub)
      .run();

    const user = {
      id: payload.sub,
      github_id: payload.github_id,
      username: payload.username,
      avatar_url: payload.avatar_url ?? null,
      terms_accepted: true,
    };

    const accessToken = await generateJWT(user, c.env.JWT_SECRET);

    return c.json({
      access_token: accessToken,
      user: {
        id: payload.sub,
        username: payload.username,
        avatar_url: payload.avatar_url,
        terms_accepted: true,
      },
    });
  })

  // Get current user from JWT
  .get("/me", async (c) => {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    try {
      const payload = await verify(header.slice(7), c.env.JWT_SECRET, "HS256");
      return c.json({ user: payload });
    } catch {
      return c.json({ error: "invalid_token" }, 401);
    }
  })

  // Logout (delete refresh token)
  .post("/logout", async (c) => {
    const { refresh_token } = await c.req.json<{ refresh_token: string }>();
    const hash = await hashToken(refresh_token);
    await c.env.DB.prepare(
      "DELETE FROM refresh_tokens WHERE token_hash = ?",
    )
      .bind(hash)
      .run();
    return c.json({ ok: true });
  });

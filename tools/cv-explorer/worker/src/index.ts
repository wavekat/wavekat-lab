import { Hono } from "hono";
import { cors } from "hono/cors";
import { clipsRoute } from "./routes/clips";
import { audioRoute } from "./routes/audio";
import { datasetsRoute } from "./routes/datasets";
import { authRoute } from "./routes/auth";
import { auth, requireTerms } from "./middleware/auth";

export type AuthUser = {
  sub: string;
  github_id: number;
  username: string;
  avatar_url?: string;
  terms_accepted: boolean;
};

export type Env = {
  Bindings: {
    DB: D1Database;
    AUDIO: R2Bucket;
    ASSETS: Fetcher;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    JWT_SECRET: string;
    TERMS_VERSION: string;
  };
  Variables: {
    user: AuthUser;
  };
};

const app = new Hono<Env>();

app.use("/api/*", cors());

// Public: auth endpoints
app.route("/api/auth", authRoute);

// Protected: all data endpoints require auth + terms
app.use("/api/clips", auth, requireTerms);
app.use("/api/audio/*", auth, requireTerms);
app.use("/api/datasets", auth, requireTerms);
app.use("/api/stats", auth, requireTerms);

app.route("/api", clipsRoute);
app.route("/api", audioRoute);
app.route("/api", datasetsRoute);

// SPA catch-all: serve index.html for any non-API, non-asset route
app.get("*", async (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/index.html";
  return c.env.ASSETS.fetch(new Request(url, c.req.raw));
});

export default app;

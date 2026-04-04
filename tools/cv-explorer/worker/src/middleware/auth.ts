import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";
import type { Env } from "../index";

export const auth = createMiddleware<Env>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const token = header.slice(7);
  try {
    const payload = (await verify(token, c.env.JWT_SECRET, "HS256")) as unknown as Env["Variables"]["user"];
    c.set("user", payload);
  } catch {
    return c.json({ error: "invalid_token" }, 401);
  }

  await next();
});

export const requireTerms = createMiddleware<Env>(async (c, next) => {
  const user = c.get("user");
  if (!user.terms_accepted) {
    return c.json({ error: "terms_not_accepted" }, 403);
  }
  await next();
});

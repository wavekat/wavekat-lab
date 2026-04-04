import { Hono } from "hono";
import type { Env } from "../index";

export const audioRoute = new Hono<Env>().get("/audio/*", async (c) => {
  const path = c.req.path.replace("/api/audio/", "");
  if (!path) {
    return c.notFound();
  }

  const object = await c.env.AUDIO.get(path);
  if (!object) {
    return c.notFound();
  }

  const headers = new Headers();
  headers.set("Content-Type", "audio/mpeg");
  headers.set("Cache-Control", "private, no-store");
  headers.set("Accept-Ranges", "bytes");

  if (object.size) {
    headers.set("Content-Length", String(object.size));
  }

  return new Response(object.body, { headers });
});

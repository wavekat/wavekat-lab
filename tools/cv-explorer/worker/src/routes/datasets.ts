import { Hono } from "hono";
import type { Env } from "../index";

export const datasetsRoute = new Hono<Env>()
  .get("/datasets", async (c) => {
    const result = await c.env.DB.prepare(
      `SELECT id, dataset_id, version, locale, split, clip_count, size_bytes, status, synced_at
       FROM datasets
       ORDER BY
         CASE status WHEN 'synced' THEN 0 WHEN 'syncing' THEN 1 ELSE 2 END,
         synced_at DESC`
    ).all();

    return c.json({ datasets: result.results });
  })
  .get("/stats", async (c) => {
    const result = await c.env.DB.prepare(
      `SELECT locale, split, COUNT(*) as clip_count
       FROM clips
       WHERE has_audio = 1
       GROUP BY locale, split
       ORDER BY locale, split`
    ).all();

    return c.json({ stats: result.results });
  });

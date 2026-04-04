import { Hono } from "hono";
import type { Env } from "../index";

const VALID_SORTS = new Set([
  "id",
  "word_count",
  "char_count",
  "up_votes",
  "down_votes",
  "sentence",
]);

export const clipsRoute = new Hono<Env>().get("/clips", async (c) => {
  const db = c.env.DB;

  const version = c.req.query("version");
  const locale = c.req.query("locale") || "en";
  const split = c.req.query("split") || "validated";
  const q = c.req.query("q");
  const minWords = c.req.query("min_words");
  const maxWords = c.req.query("max_words");
  const minChars = c.req.query("min_chars");
  const maxChars = c.req.query("max_chars");
  const gender = c.req.query("gender");
  const age = c.req.query("age");
  const hasAudio = c.req.query("has_audio");
  const sort = c.req.query("sort") || "id";
  const order = c.req.query("order") || "asc";
  const offset = Math.max(0, parseInt(c.req.query("offset") || "0", 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query("limit") || "50", 10)));

  const conditions: string[] = ["locale = ?", "split = ?"];
  const params: (string | number)[] = [locale, split];

  if (version) {
    conditions.push("version = ?");
    params.push(version);
  }
  if (q) {
    conditions.push("sentence LIKE ?");
    params.push(`%${q}%`);
  }
  if (minWords) {
    conditions.push("word_count >= ?");
    params.push(parseInt(minWords, 10));
  }
  if (maxWords) {
    conditions.push("word_count <= ?");
    params.push(parseInt(maxWords, 10));
  }
  if (minChars) {
    conditions.push("char_count >= ?");
    params.push(parseInt(minChars, 10));
  }
  if (maxChars) {
    conditions.push("char_count <= ?");
    params.push(parseInt(maxChars, 10));
  }
  if (gender) {
    conditions.push("gender = ?");
    params.push(gender);
  }
  if (age) {
    conditions.push("age = ?");
    params.push(age);
  }
  if (hasAudio === "yes") {
    conditions.push("has_audio = 1");
  } else if (hasAudio === "no") {
    conditions.push("has_audio = 0");
  }

  const where = conditions.join(" AND ");
  const sortCol = VALID_SORTS.has(sort) ? sort : "id";
  const sortOrder = order === "desc" ? "DESC" : "ASC";

  const countResult = await db
    .prepare(`SELECT COUNT(*) as total FROM clips WHERE ${where}`)
    .bind(...params)
    .first<{ total: number }>();

  const rows = await db
    .prepare(
      `SELECT id, sentence, path, word_count, char_count, up_votes, down_votes, age, gender, accent, has_audio
       FROM clips WHERE ${where}
       ORDER BY ${sortCol} ${sortOrder}
       LIMIT ? OFFSET ?`
    )
    .bind(...params, limit, offset)
    .all();

  const clips = rows.results.map((row) => ({
    id: row.id as string,
    sentence: row.sentence as string,
    audio_url: `/api/audio/${row.path}`,
    word_count: row.word_count as number,
    char_count: row.char_count as number,
    gender: (row.gender as string) || "",
    age: (row.age as string) || "",
    accent: (row.accent as string) || "",
    up_votes: row.up_votes as number,
    down_votes: row.down_votes as number,
  }));

  return c.json({
    clips,
    total: countResult?.total ?? 0,
    offset,
    limit,
  });
});

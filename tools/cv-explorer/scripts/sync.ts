/**
 * Common Voice Dataset Sync Script
 *
 * Downloads a Common Voice dataset from Mozilla Data Collective,
 * parses TSV metadata into Cloudflare D1, and uploads MP3 clips to R2.
 *
 * Usage:
 *   npx tsx sync.ts --dataset-id <id> --split validated
 *   npx tsx sync.ts --dataset-id <id> --split all
 *   npx tsx sync.ts --dataset-id <id> --split all --force
 *
 * Environment variables:
 *   DATACOLLECTIVE_API_KEY  — Mozilla Data Collective API key
 *   CLOUDFLARE_ACCOUNT_ID   — Cloudflare account ID
 *   CLOUDFLARE_API_TOKEN    — Cloudflare API token (D1 access)
 *   D1_DATABASE_ID          — D1 database ID
 *   R2_ACCESS_KEY_ID        — R2 S3-compatible access key
 *   R2_SECRET_ACCESS_KEY    — R2 S3-compatible secret key
 *   R2_BUCKET_NAME          — R2 bucket name
 */

import { execSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join, basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";

import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    split: { type: "string", default: "all" },
    "dataset-id": { type: "string" },
    "work-dir": { type: "string", default: "/tmp/cv-sync" },
    "r2-concurrency": { type: "string", default: "20" },
    "d1-batch-size": { type: "string", default: "100" },
    "skip-download": { type: "boolean", default: false },
    "skip-d1": { type: "boolean", default: false },
    "skip-r2": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
});

const SPLIT_ARG = args.split!;
const DATASET_ID = args["dataset-id"];
const WORK_DIR = args["work-dir"]!;
const R2_CONCURRENCY = parseInt(args["r2-concurrency"]!, 10);
const D1_BATCH_SIZE = parseInt(args["d1-batch-size"]!, 10);
const SKIP_DOWNLOAD = args["skip-download"]!;
const SKIP_D1 = args["skip-d1"]!;
const SKIP_R2 = args["skip-r2"]!;
const FORCE = args.force!;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

const DATACOLLECTIVE_API_KEY = requireEnv("DATACOLLECTIVE_API_KEY");
const CLOUDFLARE_ACCOUNT_ID = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const CLOUDFLARE_API_TOKEN = requireEnv("CLOUDFLARE_API_TOKEN");
const D1_DATABASE_ID = requireEnv("D1_DATABASE_ID");
const R2_ACCESS_KEY_ID = requireEnv("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = requireEnv("R2_SECRET_ACCESS_KEY");
const R2_BUCKET_NAME = requireEnv("R2_BUCKET_NAME");

// ---------------------------------------------------------------------------
// R2 client
// ---------------------------------------------------------------------------

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// ---------------------------------------------------------------------------
// Step 1: Download dataset from Data Collective
// ---------------------------------------------------------------------------

async function downloadDataset(): Promise<string> {
  if (!DATASET_ID) {
    console.error("--dataset-id is required. Find it at https://datacollective.mozillafoundation.org/datasets");
    process.exit(1);
  }

  mkdirSync(WORK_DIR, { recursive: true });

  // Get presigned download URL
  console.log(`Requesting download URL for dataset ${DATASET_ID}...`);
  const res = await fetch(
    `https://datacollective.mozillafoundation.org/api/datasets/${DATASET_ID}/download`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${DATACOLLECTIVE_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    console.error(`Data Collective API error (${res.status}): ${body}`);
    process.exit(1);
  }

  const data = (await res.json()) as {
    downloadUrl: string;
    filename: string;
    sizeBytes: number;
  };

  const archivePath = join(WORK_DIR, data.filename);
  const sizeMB = (data.sizeBytes / 1024 / 1024).toFixed(0);
  console.log(`Downloading ${data.filename} (${sizeMB} MB)...`);

  // Stream download to disk
  if (existsSync(archivePath)) {
    const existingSize = statSync(archivePath).size;
    if (existingSize === data.sizeBytes) {
      console.log("Archive already downloaded, skipping.");
      return archivePath;
    }
  }

  const dlRes = await fetch(data.downloadUrl);
  if (!dlRes.ok || !dlRes.body) {
    console.error(`Download failed: ${dlRes.status}`);
    process.exit(1);
  }

  const fileStream = createWriteStream(archivePath);
  const body = Readable.fromWeb(dlRes.body as import("node:stream/web").ReadableStream);

  let downloaded = 0;
  let lastLog = 0;
  body.on("data", (chunk: Buffer) => {
    downloaded += chunk.length;
    const now = Date.now();
    if (now - lastLog > 5000) {
      const pct = ((downloaded / data.sizeBytes) * 100).toFixed(1);
      console.log(`  ${pct}% (${(downloaded / 1024 / 1024).toFixed(0)} MB)`);
      lastLog = now;
    }
  });

  await pipeline(body, fileStream);
  console.log("Download complete.");
  return archivePath;
}

// ---------------------------------------------------------------------------
// Step 2: Extract archive
// ---------------------------------------------------------------------------

function extractArchive(archivePath: string): string {
  const extractDir = join(WORK_DIR, "extracted");
  mkdirSync(extractDir, { recursive: true });

  console.log("Extracting archive...");
  execSync(`tar -xzf "${archivePath}" -C "${extractDir}"`, {
    stdio: "inherit",
    maxBuffer: 50 * 1024 * 1024,
  });

  console.log("Extraction complete.");
  return extractDir;
}

// ---------------------------------------------------------------------------
// Step 3: Find extracted files
// ---------------------------------------------------------------------------

interface DatasetInfo {
  version: string;
  locale: string;
  splits: string[];
  localeDir: string;
  clipsDir: string;
}

const KNOWN_SPLITS = ["validated", "train", "dev", "test", "invalidated", "other"];

function detectDatasetInfo(extractDir: string): DatasetInfo {
  // Archive structure: cv-corpus-VERSION/LOCALE/split.tsv and clips/
  const topDirs = readdirSync(extractDir).filter((f) =>
    statSync(join(extractDir, f)).isDirectory()
  );

  if (topDirs.length === 0) {
    console.error("No directories found in extracted archive");
    process.exit(1);
  }

  // Find the version directory (e.g. cv-corpus-25.0-2026-03-09)
  const version = topDirs[0];
  const versionDir = join(extractDir, version);

  // Auto-detect locale: find the single subdirectory inside the version dir
  const localeDirs = readdirSync(versionDir).filter((f) =>
    statSync(join(versionDir, f)).isDirectory()
  );

  if (localeDirs.length === 0) {
    console.error(`No locale directory found in ${versionDir}`);
    process.exit(1);
  }

  const locale = localeDirs[0];
  const localeDir = join(versionDir, locale);
  const clipsDir = join(localeDir, "clips");

  if (!existsSync(clipsDir)) {
    console.error(`Clips directory not found: ${clipsDir}`);
    process.exit(1);
  }

  // Find available splits
  const availableSplits = readdirSync(localeDir)
    .filter((f) => f.endsWith(".tsv"))
    .map((f) => f.replace(/\.tsv$/, ""))
    .filter((s) => KNOWN_SPLITS.includes(s));

  // Determine which splits to process
  let splits: string[];
  if (SPLIT_ARG === "all") {
    splits = availableSplits;
  } else {
    if (!availableSplits.includes(SPLIT_ARG)) {
      console.error(`Split '${SPLIT_ARG}' not found. Available: ${availableSplits.join(", ")}`);
      process.exit(1);
    }
    splits = [SPLIT_ARG];
  }

  console.log(`Detected version: ${version}`);
  console.log(`Detected locale: ${locale}`);
  console.log(`Splits to sync: ${splits.join(", ")}`);
  console.log(`Clips dir: ${clipsDir}`);

  return { version, locale, splits, localeDir, clipsDir };
}

// ---------------------------------------------------------------------------
// Step 4: Parse TSV
// ---------------------------------------------------------------------------

interface Clip {
  id: string;         // filename without .mp3
  path: string;       // R2 key: LOCALE/clips/filename.mp3
  sentence: string;
  wordCount: number;
  charCount: number;
  upVotes: number;
  downVotes: number;
  age: string;
  gender: string;
  accent: string;
}

function parseTsv(tsvPath: string, locale: string): Clip[] {
  console.log("Parsing TSV...");
  const content = readFileSync(tsvPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());

  if (lines.length === 0) {
    console.error("TSV file is empty");
    process.exit(1);
  }

  // Parse header to find column indices
  const header = lines[0].split("\t");
  const col = (name: string): number => {
    const idx = header.indexOf(name);
    if (idx === -1) {
      // Try common alternatives
      const alternatives: Record<string, string[]> = {
        accents: ["accent", "accents"],
        path: ["path"],
        sentence: ["sentence"],
        up_votes: ["up_votes"],
        down_votes: ["down_votes"],
        age: ["age"],
        gender: ["gender"],
      };
      for (const alt of alternatives[name] ?? []) {
        const altIdx = header.indexOf(alt);
        if (altIdx !== -1) return altIdx;
      }
    }
    return idx;
  };

  const pathIdx = col("path");
  const sentenceIdx = col("sentence");
  const upVotesIdx = col("up_votes");
  const downVotesIdx = col("down_votes");
  const ageIdx = col("age");
  const genderIdx = col("gender");
  const accentIdx = col("accents");

  if (pathIdx === -1 || sentenceIdx === -1) {
    console.error(`Required columns missing. Header: ${header.join(", ")}`);
    process.exit(1);
  }

  const clips: Clip[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    const filename = cols[pathIdx];
    if (!filename) continue;

    const sentence = cols[sentenceIdx] ?? "";
    const words = sentence.trim().split(/\s+/).filter(Boolean);

    clips.push({
      id: filename.replace(/\.mp3$/, ""),
      path: `${locale}/clips/${filename}`,
      sentence,
      wordCount: words.length,
      charCount: sentence.length,
      upVotes: parseInt(cols[upVotesIdx] ?? "0", 10) || 0,
      downVotes: parseInt(cols[downVotesIdx] ?? "0", 10) || 0,
      age: cols[ageIdx] ?? "",
      gender: cols[genderIdx] ?? "",
      accent: cols[accentIdx] ?? "",
    });
  }

  console.log(`Parsed ${clips.length} clips from TSV.`);
  return clips;
}

// ---------------------------------------------------------------------------
// Step 5: Insert into D1
// ---------------------------------------------------------------------------

async function createD1Tables(): Promise<void> {
  console.log("Creating D1 tables if not exists...");

  await d1Query(`
    CREATE TABLE IF NOT EXISTS datasets (
      id          TEXT PRIMARY KEY,
      dataset_id  TEXT NOT NULL,
      version     TEXT NOT NULL,
      locale      TEXT NOT NULL,
      split       TEXT NOT NULL,
      clip_count  INTEGER DEFAULT 0,
      size_bytes  INTEGER DEFAULT 0,
      status      TEXT NOT NULL,
      synced_at   TEXT
    )
  `);

  await d1Query(`
    CREATE TABLE IF NOT EXISTS clips (
      id         TEXT PRIMARY KEY,
      version    TEXT NOT NULL,
      locale     TEXT NOT NULL,
      split      TEXT NOT NULL,
      path       TEXT NOT NULL,
      sentence   TEXT NOT NULL,
      word_count INTEGER NOT NULL,
      char_count INTEGER NOT NULL,
      up_votes   INTEGER DEFAULT 0,
      down_votes INTEGER DEFAULT 0,
      age        TEXT,
      gender     TEXT,
      accent     TEXT
    )
  `);

  // Migrate: add columns that may be missing from older schema
  const migrations = [
    "ALTER TABLE datasets ADD COLUMN version TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE datasets ADD COLUMN dataset_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE clips ADD COLUMN version TEXT NOT NULL DEFAULT ''",
  ];
  for (const sql of migrations) {
    try {
      await d1Query(sql);
    } catch {
      // column already exists — ignore
    }
  }

  const indices = [
    "CREATE INDEX IF NOT EXISTS idx_datasets_status ON datasets(status)",
    "CREATE INDEX IF NOT EXISTS idx_clips_locale_split ON clips(locale, split)",
    "CREATE INDEX IF NOT EXISTS idx_clips_version ON clips(version, locale, split)",
    "CREATE INDEX IF NOT EXISTS idx_clips_word_count ON clips(word_count)",
    "CREATE INDEX IF NOT EXISTS idx_clips_char_count ON clips(char_count)",
  ];
  for (const sql of indices) {
    await d1Query(sql);
  }
  console.log("D1 tables ready.");
}

async function d1Query(sql: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`D1 query failed (${res.status}): ${body}`);
  }

  return res.json();
}

async function d1BatchInsert(
  clips: Clip[],
  version: string,
  locale: string,
  split: string,
): Promise<void> {
  const sql = `INSERT OR IGNORE INTO clips (id, version, locale, split, path, sentence, word_count, char_count, up_votes, down_votes, age, gender, accent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  let inserted = 0;

  for (let i = 0; i < clips.length; i += D1_BATCH_SIZE) {
    const batch = clips.slice(i, i + D1_BATCH_SIZE);

    const statements = batch.map((clip) => ({
      sql,
      params: [
        clip.id,
        version,
        locale,
        split,
        clip.path,
        clip.sentence,
        clip.wordCount,
        clip.charCount,
        clip.upVotes,
        clip.downVotes,
        clip.age,
        clip.gender,
        clip.accent,
      ],
    }));

    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ batch: statements }),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`D1 batch insert failed (${res.status}): ${body}`);
    }

    inserted += batch.length;
    if (inserted % 1000 === 0 || inserted === clips.length) {
      console.log(`  D1: ${inserted}/${clips.length} rows inserted`);
    }
  }
}

async function insertIntoD1(
  clips: Clip[],
  version: string,
  locale: string,
  split: string,
): Promise<void> {
  console.log(`Inserting ${clips.length} clips into D1 (${version}/${locale}/${split})...`);

  // Clean slate: delete existing rows for this version/locale/split
  console.log(`  Deleting existing rows for ${version}/${locale}/${split}...`);
  await d1Query(
    "DELETE FROM clips WHERE version = ? AND locale = ? AND split = ?",
    [version, locale, split],
  );

  await d1BatchInsert(clips, version, locale, split);
  console.log("D1 insert complete.");
}

// ---------------------------------------------------------------------------
// Step 6: Upload MP3s to R2
// ---------------------------------------------------------------------------

async function r2ObjectExists(key: string): Promise<boolean> {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function uploadToR2(clips: Clip[], clipsDir: string): Promise<void> {
  console.log(`Uploading ${clips.length} MP3 files to R2 (concurrency: ${R2_CONCURRENCY})...`);

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  // Process clips in parallel with bounded concurrency
  const queue = [...clips];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const clip = queue.shift()!;
      const localPath = join(clipsDir, `${clip.id}.mp3`);

      if (!existsSync(localPath)) {
        failed++;
        if (failed <= 10) {
          console.warn(`  Missing file: ${localPath}`);
        }
        continue;
      }

      // Check if already uploaded
      const exists = await r2ObjectExists(clip.path);
      if (exists) {
        skipped++;
        continue;
      }

      try {
        const body = createReadStream(localPath);
        await r2.send(
          new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: clip.path,
            Body: body,
            ContentType: "audio/mpeg",
          })
        );
        uploaded++;
      } catch (err) {
        failed++;
        if (failed <= 10) {
          console.error(`  Failed to upload ${clip.path}: ${err}`);
        }
      }

      const total = uploaded + skipped + failed;
      if (total % 500 === 0) {
        console.log(`  R2: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed / ${clips.length} total`);
      }
    }
  }

  const workers = Array.from({ length: R2_CONCURRENCY }, () => worker());
  await Promise.all(workers);

  console.log(`R2 upload complete: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Datasets registry helpers
// ---------------------------------------------------------------------------

function datasetKey(version: string, locale: string, split: string): string {
  return `${version}/${locale}/${split}`;
}

async function getDatasetStatus(key: string): Promise<string | null> {
  const res = (await d1Query(
    "SELECT status FROM datasets WHERE id = ?",
    [key],
  )) as { result: Array<{ results: Array<{ status: string }> }> };
  const rows = res?.result?.[0]?.results;
  return rows?.length ? rows[0].status : null;
}

async function upsertDataset(
  key: string,
  datasetId: string,
  version: string,
  locale: string,
  split: string,
  status: string,
  clipCount = 0,
  sizeBytes = 0,
): Promise<void> {
  await d1Query(
    `INSERT OR REPLACE INTO datasets (id, dataset_id, version, locale, split, clip_count, size_bytes, status, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [key, datasetId, version, locale, split, clipCount, sizeBytes, status,
     status === "synced" ? new Date().toISOString() : null],
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Common Voice Dataset Sync ===");
  console.log(`Split: ${SPLIT_ARG}`);
  console.log(`Work dir: ${WORK_DIR}`);
  console.log();

  // Create tables first (needed for status check)
  await createD1Tables();

  // Step 1: Download
  let archivePath: string;
  if (SKIP_DOWNLOAD) {
    const files = existsSync(WORK_DIR)
      ? readdirSync(WORK_DIR).filter((f) => f.endsWith(".tar.gz"))
      : [];
    if (files.length === 0) {
      console.error("--skip-download specified but no .tar.gz found in work dir");
      process.exit(1);
    }
    archivePath = join(WORK_DIR, files[0]);
    console.log(`Using existing archive: ${archivePath}`);
  } else {
    archivePath = await downloadDataset();
  }

  // Step 2: Extract
  const extractDir = join(WORK_DIR, "extracted");
  const alreadyExtracted = existsSync(extractDir) && readdirSync(extractDir).length > 0;
  if (alreadyExtracted) {
    console.log("Already extracted, skipping extraction.");
  } else {
    extractArchive(archivePath);
  }

  // Step 3: Auto-detect version, locale, and splits
  const info = detectDatasetInfo(extractDir);
  let totalClips = 0;

  // Step 4: Process each split
  for (const split of info.splits) {
    console.log();
    console.log(`--- Syncing split: ${split} ---`);

    const key = datasetKey(info.version, info.locale, split);

    // Check if already synced
    if (!FORCE) {
      const status = await getDatasetStatus(key);
      if (status === "synced") {
        console.log(`Already synced (${key}). Use --force to re-sync.`);
        continue;
      }
    }

    // Mark as syncing
    await upsertDataset(key, DATASET_ID!, info.version, info.locale, split, "syncing");

    try {
      const tsvPath = join(info.localeDir, `${split}.tsv`);
      const clips = parseTsv(tsvPath, info.locale);

      // Insert into D1
      if (SKIP_D1) {
        console.log("Skipping D1 insert (--skip-d1).");
      } else {
        await insertIntoD1(clips, info.version, info.locale, split);
      }

      // Upload to R2
      if (SKIP_R2) {
        console.log("Skipping R2 upload (--skip-r2).");
      } else {
        await uploadToR2(clips, info.clipsDir);
      }

      // Mark as synced
      await upsertDataset(
        key, DATASET_ID!, info.version, info.locale, split, "synced",
        clips.length, statSync(archivePath).size,
      );

      totalClips += clips.length;
    } catch (err) {
      // Mark as failed
      await upsertDataset(key, DATASET_ID!, info.version, info.locale, split, "failed");
      throw err;
    }
  }

  // Summary
  console.log();
  console.log("=== Sync Complete ===");
  console.log(`Version: ${info.version}`);
  console.log(`Locale: ${info.locale}`);
  console.log(`Splits: ${info.splits.join(", ")}`);
  console.log(`Total clips processed: ${totalClips}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

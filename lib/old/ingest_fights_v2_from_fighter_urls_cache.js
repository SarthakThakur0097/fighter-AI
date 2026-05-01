// ingest_fights_v2_from_fighter_urls_cache.js
// Builds fights_v2 (thousands of fight_ids) by iterating cached UFCStats fighter profile URLs.
// Uses HTTP (avoids 443 issues), retries, small concurrency, and INSERT OR IGNORE to dedupe.
//
// Requirements:
// - ./database.js must export your sqlite3 db connection (already in your project)
// - fighter_urls.json is located at: lib/cache/fighter_urls.json (relative to this script)
//
// Run:
//   node ingest_fights_v2_from_fighter_urls_cache.js
// Optional:
//   node ingest_fights_v2_from_fighter_urls_cache.js "C:\Users\Sarthak\Documents\ML\fighter-beta\lib\cache\fighter_urls.json"

const fs = require("fs");
const path = require("path");
const db = require("./database");

// ---------------- sqlite helpers ----------------
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// ---------------- fetch helpers ----------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toHttp(url) {
  return (url || "").replace(/^https:\/\//i, "http://");
}

async function fetchHtml(url, { retries = 5, timeoutMs = 15000 } = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          Connection: "keep-alive",
        },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      const wait = 300 * Math.pow(2, attempt - 1); // 300, 600, 1200, 2400, ...
      console.warn(`[fetch] attempt ${attempt}/${retries} failed: ${e.message} | wait ${wait}ms`);
      await sleep(wait);
    } finally {
      clearTimeout(t);
    }
  }

  throw lastErr;
}

// ---------------- parsing helpers ----------------
function extractFightIdsFromFighterHtml(html) {
  // fighter page contains links like /fight-details/<16 hex>
  const re = /\/fight-details\/([a-f0-9]{16})/gi;
  const ids = new Set();
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return Array.from(ids);
}

// ---------------- db helpers ----------------
async function ensureFightsV2TableExists() {
  // Matches your fights_v2 schema pattern; safe if it already exists.
  await runAsync(`
    CREATE TABLE IF NOT EXISTS fights_v2 (
      fight_id TEXT PRIMARY KEY,
      fight_details_url TEXT NOT NULL,
      event_id TEXT,
      event_name TEXT,
      event_date TEXT,
      weight_class TEXT,
      title_bout INTEGER DEFAULT 0,
      interim_title INTEGER DEFAULT 0,
      performance_bonus INTEGER DEFAULT 0,
      fight_bonus INTEGER DEFAULT 0,
      ko_bonus INTEGER DEFAULT 0,
      submission_bonus INTEGER DEFAULT 0,
      method TEXT,
      ending_round INTEGER,
      ending_time TEXT,
      time_format TEXT,
      referee TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Helpful indexes
  await runAsync(`CREATE INDEX IF NOT EXISTS idx_fights_v2_event_id ON fights_v2(event_id);`);
  await runAsync(`CREATE INDEX IF NOT EXISTS idx_fights_v2_event_date ON fights_v2(event_date);`);
}

async function insertFightIfMissing(fightId) {
  const url = `http://ufcstats.com/fight-details/${fightId}`;
  await runAsync(
    `
    INSERT OR IGNORE INTO fights_v2 (fight_id, fight_details_url)
    VALUES (?, ?);
    `,
    [fightId, url]
  );
}

// ---------------- simple concurrency runner ----------------
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const current = idx++;
      if (current >= items.length) break;
      results[current] = await fn(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

// ---------------- main ----------------
(async () => {
  await ensureFightsV2TableExists();

  // Prefer CLI argument, otherwise default to lib/cache/fighter_urls.json
  const cachePath =
    process.argv[2] ||
    path.join(__dirname, "cache", "fighter_urls.json");

  console.log("Reading cache from:", cachePath);

  const raw = fs.readFileSync(cachePath, "utf8");
  const parsed = JSON.parse(raw);

  const fighters = parsed.fighters || [];
  console.log(`[cache] fighters in file: ${fighters.length}`);

  const before = await allAsync(`SELECT COUNT(*) AS c FROM fights_v2;`);
  console.log(`[db] fights_v2 before: ${before[0].c}`);

  // Tune these if you get throttled:
  const CONCURRENCY = 4;      // parallel fighter pages
  const POLITE_DELAY_MS = 120; // per fighter task delay

  let fightersProcessed = 0;
  let fighterFetchFailed = 0;
  let totalFightLinksFound = 0;

  await mapLimit(fighters, CONCURRENCY, async (f, i) => {
    const fighterUrl = f?.url ? toHttp(f.url) : null;
    if (!fighterUrl) return;

    try {
      // small per-task delay helps avoid bursts
      await sleep(POLITE_DELAY_MS);

      const html = await fetchHtml(fighterUrl, { retries: 5, timeoutMs: 15000 });
      const fightIds = extractFightIdsFromFighterHtml(html);

      totalFightLinksFound += fightIds.length;

      // insert deduped in DB; duplicates are ignored
      for (const fightId of fightIds) {
        await insertFightIfMissing(fightId);
      }

      fightersProcessed++;

      if ((i + 1) % 100 === 0) {
        const nowCount = await allAsync(`SELECT COUNT(*) AS c FROM fights_v2;`);
        console.log(
          `[progress] ${i + 1}/${fighters.length} fighters | processed=${fightersProcessed} failed=${fighterFetchFailed} | fight_links_found=${totalFightLinksFound} | fights_v2=${nowCount[0].c}`
        );
      }
    } catch (e) {
      fighterFetchFailed++;
      console.warn(`[WARN] fighter fetch failed (${fighterUrl}): ${e.message}`);
    }
  });

  const after = await allAsync(`SELECT COUNT(*) AS c FROM fights_v2;`);
  console.log(`[db] fights_v2 after: ${after[0].c}`);
  console.log(`[done] fightersProcessed=${fightersProcessed}, fighterFetchFailed=${fighterFetchFailed}`);
  console.log(`[done] fight links found total (incl dups): ${totalFightLinksFound}`);

  process.exit(0);
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

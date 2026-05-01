// upsertFighter.test.js
// Tests for upsertFighter function in pipeline_ingest_v3.js
// Uses in-memory SQLite so real DB is never touched

const sqlite3 = require("sqlite3").verbose();

// Mock the scraper so cheerio is never imported during tests
jest.mock("../lib/jobs/ufcstats_scraper_enhanced", () => ({
  scrapeEnhancedFighterByUrl: jest.fn(),
  parseOfStr: jest.fn(),
  parsePct: (val) => {
    const m = /([\d.]+)\s*%/.exec(String(val || ""));
    if (!m) return null;
    const v = parseFloat(m[1]);
    return isFinite(v) ? v / 100 : null;
  },
  parseCtrlTime: jest.fn(),
}));

const { upsertFighter } = require("../lib/jobs/pipeline_ingest_v3");

// ---- Helpers ----------------------------------------------------------------

function openDb() {
  const db = new sqlite3.Database(":memory:");
  db.configure("busyTimeout", 10000);
  return db;
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

async function createSchema(db) {
  await run(db, `
    CREATE TABLE IF NOT EXISTS fighters_v2 (
      fighter_id TEXT PRIMARY KEY,
      name TEXT,
      nickname TEXT,
      dob TEXT,
      height TEXT,
      weight TEXT,
      reach TEXT,
      stance TEXT,
      record TEXT,
      slpm REAL,
      str_acc REAL,
      sapm REAL,
      str_def REAL,
      td_avg REAL,
      td_acc REAL,
      td_def REAL,
      sub_avg REAL,
      source_url TEXT,
      is_stub INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Tables referenced by upsertFighter stub upgrade logic
  await run(db, `CREATE TABLE IF NOT EXISTS fight_fighters_v2 (
    fight_id TEXT, fighter_id TEXT, corner TEXT, result TEXT,
    PRIMARY KEY (fight_id, fighter_id)
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS fight_round_stats_v2 (
    round_id TEXT, fighter_id TEXT
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS fight_round_sig_strikes_v2 (
    round_id TEXT, fighter_id TEXT
  )`);
  await run(db, `CREATE TABLE IF NOT EXISTS fight_totals_v2 (
    fight_id TEXT, fighter_id TEXT
  )`);
}

// ---- Sample Data ------------------------------------------------------------

const sampleFighter = {
  name: "Jon Jones",
  nickname: "Bones",
  dob: "1987-07-19",
  height: "6' 4\"",
  weight: "205 lbs.",
  reach: "84.5\"",
  stance: "Orthodox",
  record: "27-1-0",
  slpm: 4.29,
  str_acc: "57%",
  sapm: 2.11,
  str_def: "64%",
  td_avg: 1.86,
  td_acc: "42%",
  td_def: "96%",
  sub_avg: 0.6,
  source_url: "http://ufcstats.com/fighter-details/07f72a2a7591b409",
};

// ---- Tests ------------------------------------------------------------------

describe("upsertFighter", () => {
  let db;

  beforeEach(async () => {
    db = openDb();
    await createSchema(db);
    await run(db, "PRAGMA foreign_keys = ON");
  });

  afterEach((done) => {
    db.close(done);
  });

  test("inserts a new fighter correctly", async () => {
    const id = await upsertFighter(db, sampleFighter);

    expect(id).toBe("07f72a2a7591b409");

    const row = await get(db, "SELECT * FROM fighters_v2 WHERE fighter_id = ?", [id]);
    expect(row).not.toBeNull();
    expect(row.name).toBe("Jon Jones");
    expect(row.is_stub).toBe(0);
  });

  test("does not duplicate fighter on second upsert", async () => {
    await upsertFighter(db, sampleFighter);
    await upsertFighter(db, sampleFighter);

    const row = await get(
      db,
      "SELECT COUNT(*) as count FROM fighters_v2 WHERE name = ?",
      ["Jon Jones"]
    );
    expect(row.count).toBe(1);
  });

  test("upgrades a stub fighter to a real profile", async () => {
    // Insert a stub with the same name first
    const stubId = "stub:abc123";
    await run(
      db,
      `INSERT INTO fighters_v2 (fighter_id, name, is_stub) VALUES (?, ?, 1)`,
      [stubId, "Jon Jones"]
    );

    // Now upsert the real fighter
    const realId = await upsertFighter(db, sampleFighter);

    // Stub should be gone
    const stub = await get(db, "SELECT * FROM fighters_v2 WHERE fighter_id = ?", [stubId]);
    expect(stub).toBeUndefined();

    // Real fighter should exist
    const real = await get(db, "SELECT * FROM fighters_v2 WHERE fighter_id = ?", [realId]);
    expect(real).not.toBeNull();
    expect(real.is_stub).toBe(0);
    expect(real.nickname).toBe("Bones");
  });

  test("returns correct fighter_id from source_url", async () => {
    const id = await upsertFighter(db, sampleFighter);
    expect(id).toBe("07f72a2a7591b409");
  });

  test("throws if source_url is missing", async () => {
    const badFighter = { ...sampleFighter, source_url: null };
    await expect(upsertFighter(db, badFighter)).rejects.toThrow("No fighter_id from URL");
  });
});
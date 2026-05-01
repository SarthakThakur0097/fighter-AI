// enrichStubs.test.js
// Tests for findStubToRealMatches and updateForeignKeyReferences
// in enrich_fighter_stubs.js

const sqlite3 = require("sqlite3").verbose();
const {
  findStubToRealMatches,
  updateForeignKeyReferences,
} = require("../lib/ops/enrich_fighter_stubs");

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
      is_stub INTEGER DEFAULT 0
    )
  `);

  await run(db, `
    CREATE TABLE IF NOT EXISTS fight_fighters_v2 (
      fight_id TEXT,
      fighter_id TEXT,
      corner TEXT,
      result TEXT,
      PRIMARY KEY (fight_id, fighter_id)
    )
  `);

  await run(db, `CREATE TABLE IF NOT EXISTS fight_round_stats_v2 (round_id TEXT, fighter_id TEXT)`);
  await run(db, `CREATE TABLE IF NOT EXISTS fight_round_sig_strikes_v2 (round_id TEXT, fighter_id TEXT)`);
  await run(db, `CREATE TABLE IF NOT EXISTS fight_totals_v2 (fight_id TEXT, fighter_id TEXT)`);
}

// ---- Tests ------------------------------------------------------------------

describe("findStubToRealMatches", () => {
  let db;

  beforeEach(async () => {
    db = openDb();
    await createSchema(db);
  });

  afterEach((done) => {
    db.close(done);
  });

  test("finds a stub that matches a real fighter by name", async () => {
    await run(db, `INSERT INTO fighters_v2 VALUES ('real-001', 'Jon Jones', 0)`);
    await run(db, `INSERT INTO fighters_v2 VALUES ('stub-001', 'Jon Jones', 1)`);

    const matches = await findStubToRealMatches(db);

    expect(matches.length).toBe(1);
    expect(matches[0].stub_id).toBe("stub-001");
    expect(matches[0].real_id).toBe("real-001");
  });

  test("returns empty array when no stubs exist", async () => {
    await run(db, `INSERT INTO fighters_v2 VALUES ('real-001', 'Jon Jones', 0)`);

    const matches = await findStubToRealMatches(db);
    expect(matches.length).toBe(0);
  });

  test("does not match two real fighters with same name", async () => {
    await run(db, `INSERT INTO fighters_v2 VALUES ('real-001', 'Jon Jones', 0)`);
    await run(db, `INSERT INTO fighters_v2 VALUES ('real-002', 'Jon Jones', 0)`);

    const matches = await findStubToRealMatches(db);
    expect(matches.length).toBe(0);
  });

  test("matches names that differ only by punctuation or spacing", async () => {
    await run(db, `INSERT INTO fighters_v2 VALUES ('real-001', 'Jon Jones', 0)`);
    await run(db, `INSERT INTO fighters_v2 VALUES ('stub-001', 'Jon  Jones', 1)`);

    const matches = await findStubToRealMatches(db);
    expect(matches.length).toBe(1);
  });
});

describe("updateForeignKeyReferences", () => {
  let db;

  beforeEach(async () => {
    db = openDb();
    await createSchema(db);
  });

  afterEach((done) => {
    db.close(done);
  });

  test("updates fight_fighters_v2 stub references to real fighter id", async () => {
    await run(db, `INSERT INTO fighters_v2 VALUES ('real-001', 'Jon Jones', 0)`);
    await run(db, `INSERT INTO fighters_v2 VALUES ('stub-001', 'Jon Jones', 1)`);
    await run(db, `INSERT INTO fight_fighters_v2 VALUES ('fight-001', 'stub-001', 'fighter_1', 'win')`);

    await updateForeignKeyReferences(db, "stub-001", "real-001");

    const row = await get(
      db,
      "SELECT * FROM fight_fighters_v2 WHERE fight_id = 'fight-001'"
    );
    expect(row.fighter_id).toBe("real-001");
  });

  test("deletes stub fight entry when real fighter already exists in same fight", async () => {
    await run(db, `INSERT INTO fighters_v2 VALUES ('real-001', 'Jon Jones', 0)`);
    await run(db, `INSERT INTO fighters_v2 VALUES ('stub-001', 'Jon Jones', 1)`);

    // Both stub and real already in same fight
    await run(db, `INSERT INTO fight_fighters_v2 VALUES ('fight-001', 'real-001', 'fighter_1', 'win')`);
    await run(db, `INSERT INTO fight_fighters_v2 VALUES ('fight-001', 'stub-001', 'fighter_2', 'loss')`);

    await updateForeignKeyReferences(db, "stub-001", "real-001");

    const stubRow = await get(
      db,
      "SELECT * FROM fight_fighters_v2 WHERE fight_id = 'fight-001' AND fighter_id = 'stub-001'"
    );
    expect(stubRow).toBeUndefined();
  });
});
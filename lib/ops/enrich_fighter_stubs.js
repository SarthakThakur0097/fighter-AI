// enrich_fighter_stubs.js
// Merges stub fighters with their real profiles after scraping
// Usage: node enrich_fighter_stubs.js

const { openDb, run, get, all } = require("../db/connection");
const DB_PATH = process.env.DB_PATH || "mma_fighters.db";

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

async function findStubToRealMatches(db) {
  const sql = `
    SELECT 
      stub.fighter_id as stub_id,
      stub.name as stub_name,
      real.fighter_id as real_id,
      real.name as real_name
    FROM fighters_v2 stub
    JOIN fighters_v2 real 
      ON LOWER(REPLACE(REPLACE(REPLACE(stub.name, ' ', ''), '.', ''), '-', ''))
       = LOWER(REPLACE(REPLACE(REPLACE(real.name, ' ', ''), '.', ''), '-', ''))
    WHERE stub.is_stub = 1 
      AND real.is_stub = 0
      AND stub.fighter_id != real.fighter_id
  `;

  return await all(db, sql);
}

async function updateForeignKeyReferences(db, stubId, realId) {
  const updates = [];

  // Special handling for fight_fighters_v2 (has composite primary key)
  // Check for conflicts where real fighter already exists in the fight
  const conflicts = await all(
    db,
    `SELECT DISTINCT ff_stub.fight_id 
     FROM fight_fighters_v2 ff_stub
     JOIN fight_fighters_v2 ff_real ON ff_stub.fight_id = ff_real.fight_id
     WHERE ff_stub.fighter_id = ? AND ff_real.fighter_id = ?`,
    [stubId, realId]
  );

  const conflictFightIds = conflicts.map((c) => c.fight_id);

  if (conflictFightIds.length > 0) {
    // Delete stub entries where real fighter already exists
    const placeholders = conflictFightIds.map(() => "?").join(",");
    const deleteResult = await run(
      db,
      `DELETE FROM fight_fighters_v2 
       WHERE fighter_id = ? AND fight_id IN (${placeholders})`,
      [stubId, ...conflictFightIds]
    );

    updates.push({
      table: "fight_fighters_v2",
      rows_updated: 0,
      rows_deleted: deleteResult.changes || 0,
      note: "Deleted stub entries (real fighter already exists)",
    });
  }

  // Update remaining stub entries (no conflict)
  const updateResult = await run(
    db,
    `UPDATE fight_fighters_v2 SET fighter_id = ? WHERE fighter_id = ?`,
    [realId, stubId]
  );

  updates.push({
    table: "fight_fighters_v2",
    rows_updated: updateResult.changes || 0,
    rows_deleted: 0,
    note: "Updated stub → real (no conflicts)",
  });

  // Other tables can be updated normally (no composite key conflicts)
  const otherTables = [
    { table: "fight_round_stats_v2", column: "fighter_id" },
    { table: "fight_round_sig_strikes_v2", column: "fighter_id" },
    { table: "fight_totals_v2", column: "fighter_id" },
  ];

  for (const { table, column } of otherTables) {
    const result = await run(
      db,
      `UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`,
      [realId, stubId]
    );

    updates.push({
      table,
      rows_updated: result.changes || 0,
      rows_deleted: 0,
    });
  }

  return updates;
}

async function deleteStub(db, stubId) {
  await run(db, `DELETE FROM fighters_v2 WHERE fighter_id = ?`, [stubId]);
}

async function getEnrichmentStats(db) {
  const stats = {
    total_fighters: 0,
    real_fighters: 0,
    stub_fighters: 0,
    fights_with_both_fighters: 0,
    fights_with_stubs: 0,
  };

  const counts = await all(
    db,
    `
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN is_stub = 0 THEN 1 ELSE 0 END) as real,
      SUM(CASE WHEN is_stub = 1 THEN 1 ELSE 0 END) as stubs
    FROM fighters_v2
  `
  );

  if (counts[0]) {
    stats.total_fighters = counts[0].total;
    stats.real_fighters = counts[0].real;
    stats.stub_fighters = counts[0].stubs;
  }

  const fightStats = await all(
    db,
    `
    SELECT 
      COUNT(DISTINCT f.fight_id) as total_fights,
      COUNT(DISTINCT CASE 
        WHEN stub_count = 0 THEN f.fight_id 
      END) as fights_with_both_real
    FROM fights_v2 f
    LEFT JOIN (
      SELECT 
        ff.fight_id,
        SUM(CASE WHEN fi.is_stub = 1 THEN 1 ELSE 0 END) as stub_count
      FROM fight_fighters_v2 ff
      JOIN fighters_v2 fi ON ff.fighter_id = fi.fighter_id
      GROUP BY ff.fight_id
    ) stub_counts ON f.fight_id = stub_counts.fight_id
  `
  );

  if (fightStats[0]) {
    stats.fights_with_both_fighters = fightStats[0].fights_with_both_real || 0;
    stats.fights_with_stubs =
      fightStats[0].total_fights - stats.fights_with_both_fighters;
  }

  return stats;
}

async function main() {
  console.log("[ENRICHMENT] Starting stub fighter enrichment...\n");

  const db = openDb(DB_PATH);
  await run(db, "PRAGMA foreign_keys = ON");

  try {
    // Get stats before enrichment
    console.log("[BEFORE] Database state:");
    const statsBefore = await getEnrichmentStats(db);
    console.log(`  Total fighters: ${statsBefore.total_fighters}`);
    console.log(`  Real fighters: ${statsBefore.real_fighters}`);
    console.log(`  Stub fighters: ${statsBefore.stub_fighters}`);
    console.log(
      `  Fights with both real fighters: ${statsBefore.fights_with_both_fighters}`
    );
    console.log(`  Fights with stubs: ${statsBefore.fights_with_stubs}\n`);

    // Find matches
    console.log("[MATCHING] Finding stub-to-real fighter matches...");
    const matches = await findStubToRealMatches(db);
    console.log(`[MATCHING] Found ${matches.length} matches\n`);

    if (matches.length === 0) {
      console.log(
        "✅ No stubs to enrich. All fighters are already real profiles or have no matches."
      );
      return;
    }

    // Process each match
    console.log("[PROCESSING] Merging stubs with real profiles...\n");
    let totalUpdates = 0;

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      console.log(
        `[${i + 1}/${matches.length}] Merging: "${match.stub_name}" (stub) → "${
          match.real_name
        }" (real)`
      );
      console.log(`  Stub ID: ${match.stub_id}`);
      console.log(`  Real ID: ${match.real_id}`);

      // Update all foreign key references
      const updates = await updateForeignKeyReferences(
        db,
        match.stub_id,
        match.real_id
      );

      let matchUpdates = 0;
// Inside the match processing loop, replace the updates logging:
    for (const update of updates) {
    if (update.rows_updated > 0 || update.rows_deleted > 0) {
        let msg = `    ✓ ${update.table}:`;
        if (update.rows_updated > 0) msg += ` ${update.rows_updated} updated`;
        if (update.rows_deleted > 0) msg += ` ${update.rows_deleted} deleted`;
        if (update.note) msg += ` (${update.note})`;
        console.log(msg);
        matchUpdates += update.rows_updated + update.rows_deleted;
    }
    }

      totalUpdates += matchUpdates;

      // Delete the stub
      await deleteStub(db, match.stub_id);
      console.log(`    ✓ Stub deleted\n`);
    }

    // Get stats after enrichment
    console.log("\n[AFTER] Database state:");
    const statsAfter = await getEnrichmentStats(db);
    console.log(`  Total fighters: ${statsAfter.total_fighters}`);
    console.log(`  Real fighters: ${statsAfter.real_fighters}`);
    console.log(`  Stub fighters: ${statsAfter.stub_fighters}`);
    console.log(
      `  Fights with both real fighters: ${statsAfter.fights_with_both_fighters}`
    );
    console.log(`  Fights with stubs: ${statsAfter.fights_with_stubs}\n`);

    console.log(
      `✅ SUCCESS! Enriched ${matches.length} fighters with ${totalUpdates} total updates.`
    );
  } catch (error) {
    console.error("\n❌ ERROR:", error);
    throw error;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { findStubToRealMatches, updateForeignKeyReferences };

// check_progress.js
// Quick progress check
// Usage: node check_progress.js

const { openDb, run, get, all } = require("../db/connection");

const DB_PATH = process.env.DB_PATH || "mma_fighters.db";

async function main() {
  const db = openDb(DB_PATH);

  try {
    // Progress stats
    const progress = await all(
      db,
      `SELECT status, COUNT(*) as count
       FROM ingestion_fighter_progress_v2
       GROUP BY status`
    );

    console.log("\n📊 INGESTION PROGRESS");
    console.log("=".repeat(40));

    let total = 0;
    const stats = {};
    progress.forEach((row) => {
      console.log(`  ${row.status}: ${row.count}`);
      stats[row.status] = row.count;
      total += row.count;
    });

    const pending = stats.pending || 0;
    const success = stats.success || 0;
    const failed = stats.failed || 0;

    const percentComplete = ((success / total) * 100).toFixed(1);

    console.log("=".repeat(40));
    console.log(`  Total: ${total}`);
    console.log(`  Progress: ${percentComplete}% complete`);

    // Recent failures
    if (failed > 0) {
      console.log("\n⚠️  RECENT FAILURES (last 5):");
      const failures = await all(
        db,
        `SELECT name, last_error, attempts, updated_at
         FROM ingestion_fighter_progress_v2
         WHERE status = 'failed'
         ORDER BY updated_at DESC
         LIMIT 5`
      );

      failures.forEach((f) => {
        console.log(`  - ${f.name} (${f.attempts} attempts)`);
        console.log(`    Error: ${f.last_error}`);
      });
    }

    // Database stats
    const dbStats = await all(
      db,
      `SELECT 
        (SELECT COUNT(*) FROM fighters_v2) as total_fighters,
        (SELECT COUNT(*) FROM fighters_v2 WHERE is_stub = 0) as real_fighters,
        (SELECT COUNT(*) FROM fighters_v2 WHERE is_stub = 1) as stub_fighters,
        (SELECT COUNT(*) FROM fights_v2) as total_fights`
    );

    console.log("\n📦 DATABASE STATS");
    console.log("=".repeat(40));
    console.log(`  Fighters: ${dbStats[0].total_fighters}`);
    console.log(`    Real: ${dbStats[0].real_fighters}`);
    console.log(`    Stubs: ${dbStats[0].stub_fighters}`);
    console.log(`  Fights: ${dbStats[0].total_fights}`);
  } catch (error) {
    console.error("❌ ERROR:", error);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}

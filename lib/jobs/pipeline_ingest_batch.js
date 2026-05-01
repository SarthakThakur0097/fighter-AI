// pipeline_ingest_batch.js
// Database-driven batch ingestion pipeline
// Usage: node pipeline_ingest_batch.js [--batch-size 20] [--max-fighters 100]

const sqlite3 = require("sqlite3").verbose();
const { scrapeEnhancedFighterByUrl } = require("./ufcstats_scraper_enhanced");
const { openDb, run, get, all } = require("../db/connection");
// ---- Config -----------------------------------------------------------------
const DB_PATH = process.env.DB_PATH || "mma_fighters.db";

// Parse command line arguments
const args = process.argv.slice(2);
const batchSize = parseInt(
  args.find((a) => a.startsWith("--batch-size="))?.split("=")[1] || "20"
);
const maxFighters = parseInt(
  args.find((a) => a.startsWith("--max-fighters="))?.split("=")[1] || "999999"
);

// Import helper functions from pipeline_ingest_v3
const { upsertFighter, ingestFight } = require("./pipeline_ingest_v3");


// ---- Progress Tracking ------------------------------------------------------

async function getPendingFighters(db, limit) {
  return await all(
    db,
    `SELECT ufcstats_fighter_id, name, ufcstats_url, attempts
     FROM ingestion_fighter_progress_v2
     WHERE status = 'pending'
     ORDER BY attempts ASC, name ASC
     LIMIT ?`,
    [limit]
  );
}

async function markFighterStatus(db, fighterId, status, error = null) {
  await run(
    db,
    `UPDATE ingestion_fighter_progress_v2
     SET status = ?,
         attempts = attempts + 1,
         last_error = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE ufcstats_fighter_id = ?`,
    [status, error, fighterId]
  );
}

async function getProgressStats(db) {
  const stats = await all(
    db,
    `SELECT status, COUNT(*) as count
     FROM ingestion_fighter_progress_v2
     GROUP BY status`
  );

  const result = {
    pending: 0,
    success: 0,
    failed: 0,
    total: 0,
  };

  stats.forEach((row) => {
    result[row.status] = row.count;
    result.total += row.count;
  });

  return result;
}

// ---- Main -------------------------------------------------------------------

async function processFighter(db, fighter) {
  const startTime = Date.now();

  try {
    console.log(`\n[SCRAPE] ${fighter.name}`);
    console.log(`  URL: ${fighter.ufcstats_url}`);
    console.log(`  Attempt: ${fighter.attempts + 1}`);

    // Scrape fighter
    const data = await scrapeEnhancedFighterByUrl(fighter.ufcstats_url);
    console.log(`  Found ${data.fights.length} fights`);

    // Insert fighter profile
    const fighterId = await upsertFighter(db, data);
    console.log(`  Fighter ID: ${fighterId}`);

    // Insert all fights
    for (let i = 0; i < data.fights.length; i++) {
      await ingestFight(db, data.fights[i], fighterId);
    }

    // Mark as successful
    await markFighterStatus(db, fighter.ufcstats_fighter_id, "success");

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  ✅ SUCCESS (${elapsed}s)`);

    return { success: true, fights: data.fights.length, time: elapsed };
  } catch (error) {
    console.error(`  ❌ FAILED: ${error.message}`);

    // Mark as failed
    await markFighterStatus(
      db,
      fighter.ufcstats_fighter_id,
      "failed",
      error.message
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    return { success: false, error: error.message, time: elapsed };
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("BATCH INGESTION PIPELINE");
  console.log("=".repeat(70));
  console.log(`Batch size: ${batchSize}`);
  console.log(`Max fighters: ${maxFighters}`);
  console.log("=".repeat(70));

  const db = openDb(DB_PATH);
  await run(db, "PRAGMA foreign_keys = ON");

  try {
    // Initial stats
    console.log("\n[INITIAL STATE]");
    const initialStats = await getProgressStats(db);
    console.log(`  Total fighters: ${initialStats.total}`);
    console.log(`  Pending: ${initialStats.pending}`);
    console.log(`  Success: ${initialStats.success}`);
    console.log(`  Failed: ${initialStats.failed}`);

    if (initialStats.pending === 0) {
      console.log("\n✅ No pending fighters! All done.");
      return;
    }

    // Process in batches
    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    let totalFights = 0;

    while (totalProcessed < maxFighters) {
      // Get next batch
      const batch = await getPendingFighters(db, batchSize);

      if (batch.length === 0) {
        console.log("\n✅ No more pending fighters!");
        break;
      }

      console.log(`\n${"=".repeat(70)}`);
      console.log(`BATCH: Processing ${batch.length} fighters`);
      console.log("=".repeat(70));

      // Process each fighter in batch
      for (let i = 0; i < batch.length; i++) {
        const fighter = batch[i];

        console.log(`\n[${i + 1}/${batch.length}] ${fighter.name}`);

        const result = await processFighter(db, fighter);

        if (result.success) {
          totalSuccess++;
          totalFights += result.fights;
        } else {
          totalFailed++;
        }

        totalProcessed++;

        // Rate limiting between fighters
        if (i < batch.length - 1) {
          console.log("  [RATE LIMIT] Waiting 2 seconds...");
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        // Check if we've hit max fighters
        if (totalProcessed >= maxFighters) {
          console.log(`\n[LIMIT] Reached max fighters (${maxFighters})`);
          break;
        }
      }

      // Batch complete
      console.log(`\n${"=".repeat(70)}`);
      console.log("BATCH COMPLETE");
      console.log("=".repeat(70));
      console.log(`Processed: ${totalProcessed}`);
      console.log(`Success: ${totalSuccess}`);
      console.log(`Failed: ${totalFailed}`);
      console.log(`Total fights ingested: ${totalFights}`);

      // Check if should continue
      if (totalProcessed >= maxFighters) {
        break;
      }

      // Wait between batches
      console.log("\n[BATCH DELAY] Waiting 5 seconds before next batch...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Final stats
    console.log("\n" + "=".repeat(70));
    console.log("PIPELINE COMPLETE");
    console.log("=".repeat(70));

    const finalStats = await getProgressStats(db);
    console.log("\n[FINAL STATE]");
    console.log(`  Total fighters: ${finalStats.total}`);
    console.log(`  Pending: ${finalStats.pending}`);
    console.log(`  Success: ${finalStats.success}`);
    console.log(`  Failed: ${finalStats.failed}`);

    console.log("\n[THIS RUN]");
    console.log(`  Processed: ${totalProcessed}`);
    console.log(`  Success: ${totalSuccess}`);
    console.log(`  Failed: ${totalFailed}`);
    console.log(`  Total fights: ${totalFights}`);

    // Database stats
    const dbStats = {
      fighters: (await get(db, "SELECT COUNT(*) as c FROM fighters_v2")).c,
      real_fighters: (
        await get(db, "SELECT COUNT(*) as c FROM fighters_v2 WHERE is_stub = 0")
      ).c,
      stub_fighters: (
        await get(db, "SELECT COUNT(*) as c FROM fighters_v2 WHERE is_stub = 1")
      ).c,
      fights: (await get(db, "SELECT COUNT(*) as c FROM fights_v2")).c,
    };

    console.log("\n[DATABASE]");
    console.log(`  Total fighters: ${dbStats.fighters}`);
    console.log(`  Real fighters: ${dbStats.real_fighters}`);
    console.log(`  Stub fighters: ${dbStats.stub_fighters}`);
    console.log(`  Total fights: ${dbStats.fights}`);

    console.log(
      "\n💡 TIP: Run 'node enrich_fighter_stubs.js' to merge stub fighters"
    );
  } catch (error) {
    console.error("\n❌ FATAL ERROR:", error);
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

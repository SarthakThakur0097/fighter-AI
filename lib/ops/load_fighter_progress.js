// load_fighter_progress.js
// Loads fighters_url.json into ingestion_fighter_progress_v2 table
// Usage: node load_fighter_progress.js [path/to/fighters_url.json]

const { openDb, run, get, all } = require("../db/connection");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH || "mma_fighters.db";
const FIGHTERS_JSON = process.argv[2] || "C:\Users\Sarthak\Documents\ML\fighter-beta\lib\cache\fighter_urls.json";


function extractFighterId(url) {
  const match = /fighter-details\/([a-z0-9]+)/i.exec(url);
  return match ? match[1] : null;
}

async function main() {
  console.log("[LOAD] Loading fighter URLs into progress table...\n");

  // Load JSON
  if (!fs.existsSync(FIGHTERS_JSON)) {
    throw new Error(`File not found: ${FIGHTERS_JSON}`);
  }

  const data = JSON.parse(fs.readFileSync(FIGHTERS_JSON, "utf8"));
  const fighters = data.fighters || [];

  console.log(`[LOAD] Found ${fighters.length} fighters in JSON\n`);

  const db = openDb(DB_PATH);
  await run(db, "PRAGMA foreign_keys = ON");

  try {
    // Check existing progress
    const existing = await all(
      db,
      "SELECT ufcstats_fighter_id FROM ingestion_fighter_progress_v2"
    );
    const existingIds = new Set(existing.map((r) => r.ufcstats_fighter_id));

    console.log(`[LOAD] Existing progress entries: ${existingIds.size}`);

    // Insert new fighters
    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < fighters.length; i++) {
      const fighter = fighters[i];
      const fighterId = extractFighterId(fighter.url);

      if (!fighterId) {
        console.warn(`[WARN] Invalid URL for ${fighter.name}: ${fighter.url}`);
        errors++;
        continue;
      }

      // Skip if already exists
      if (existingIds.has(fighterId)) {
        skipped++;
        continue;
      }

      try {
        await run(
          db,
          `INSERT INTO ingestion_fighter_progress_v2 
           (v1_id, name, ufcstats_url, ufcstats_fighter_id, status, attempts)
           VALUES (?, ?, ?, ?, 'pending', 0)`,
          [null, fighter.name, fighter.url, fighterId]
        );
        inserted++;

        if ((inserted + skipped) % 100 === 0) {
          console.log(
            `[PROGRESS] Processed ${inserted + skipped}/${fighters.length}...`
          );
        }
      } catch (err) {
        console.error(`[ERROR] Failed to insert ${fighter.name}:`, err.message);
        errors++;
      }
    }

    // Summary
    console.log("\n" + "=".repeat(70));
    console.log("LOAD COMPLETE");
    console.log("=".repeat(70));
    console.log(`Total fighters in JSON: ${fighters.length}`);
    console.log(`Inserted (new): ${inserted}`);
    console.log(`Skipped (already exists): ${skipped}`);
    console.log(`Errors: ${errors}`);

    // Status breakdown
    const statusCounts = await all(
      db,
      `SELECT status, COUNT(*) as count 
       FROM ingestion_fighter_progress_v2 
       GROUP BY status`
    );

    console.log("\n[STATUS BREAKDOWN]");
    statusCounts.forEach((row) => {
      console.log(`  ${row.status}: ${row.count}`);
    });

    console.log("\n✅ Ready to run batch ingestion!");
    console.log("   Usage: node pipeline_ingest_batch.js --batch-size 20");
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

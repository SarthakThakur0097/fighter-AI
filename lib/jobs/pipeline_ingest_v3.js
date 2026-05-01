// pipeline_ingest_v3.js
// Ingestion pipeline for v2 schema with complete stats
// node pipeline_ingest_v3.js

const {scrapeEnhancedFighterByUrl} = require("./ufcstats_scraper_enhanced");
const { openDb, run, get, all } = require("../db/connection");
const { upsertFighter } = require("../repository/fighterRepo");
const { ingestFight, ingestRoundStats, ingestSigStrikesRound, ingestFightTotals } = require("../repository/fightRepo");

// ---- Config -----------------------------------------------------------------
const DB_PATH = process.env.DB_PATH || "mma_fighters.db";
const FIGHTER_URL = [
  "http://ufcstats.com/fighter-details/07f72a2a7591b409", // Jon Jones
  "http://ufcstats.com/fighter-details/d28dee5c705991df", // Stipe Miocic (example)
  "http://ufcstats.com/fighter-details/787bb1f087ccff8a",
  "http://ufcstats.com/fighter-details/2e19380f34871c6a",
  "http://ufcstats.com/fighter-details/dea070ed4a2a8281",
];

// ---- Main -------------------------------------------------------------------
async function main() {
  console.log(
    `[START] Scraping and ingesting ${FIGHTER_URL.length} fighters...\n`
  );

  const db = openDb(DB_PATH);
  await run(db, "PRAGMA foreign_keys = ON");

  const results = {
    successful: [],
    failed: [],
  };

  try {
    // Loop through each fighter
    for (let i = 0; i < FIGHTER_URL.length; i++) {
      const url = FIGHTER_URL[i];
      console.log(`\n${"=".repeat(70)}`);
      console.log(
        `[${i + 1}/${FIGHTER_URL.length}] Processing fighter: ${url}`
      );
      console.log("=".repeat(70));

      try {
        // Scrape fighter
        console.log("[SCRAPE] Fetching data from UFCStats...");
        const data = await scrapeEnhancedFighterByUrl(url);
        console.log(`[SCRAPE] Complete! Found ${data.fights.length} fights\n`);

        // Insert fighter profile
        console.log("[INSERT] Fighter profile...");
        const fighterId = await upsertFighter(db, data);
        console.log(`[INSERT] Fighter: ${data.name} (ID: ${fighterId})\n`);

        // Insert all fights
        console.log("[INSERT] Processing fights...");
        for (let j = 0; j < data.fights.length; j++) {
          console.log(`  [${j + 1}/${data.fights.length}]`);
          await ingestFight(db, data.fights[j], fighterId);
        }

        results.successful.push({
          url,
          name: data.name,
          fights: data.fights.length,
        });
        console.log(
          `\n✅ SUCCESS: ${data.name} - ${data.fights.length} fights ingested`
        );

        // Rate limiting: Wait 2 seconds between fighters (be respectful)
        if (i < FIGHTER_URL.length - 1) {
          console.log(
            "\n[RATE LIMIT] Waiting 2 seconds before next fighter..."
          );
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } catch (error) {
        console.error(`\n❌ FAILED: ${url}`);
        console.error(`   Error: ${error.message}`);
        results.failed.push({ url, error: error.message });

        // Continue with next fighter even if this one failed
        console.log("   Continuing with next fighter...");
      }
    }

    // Final summary
    console.log("\n" + "=".repeat(70));
    console.log("INGESTION COMPLETE");
    console.log("=".repeat(70));

    // Verify database state
    console.log("\n[VERIFY] Database contents:");
    const counts = {
      fighters: (await get(db, "SELECT COUNT(*) as c FROM fighters_v2")).c,
      real_fighters: (
        await get(db, "SELECT COUNT(*) as c FROM fighters_v2 WHERE is_stub = 0")
      ).c,
      stub_fighters: (
        await get(db, "SELECT COUNT(*) as c FROM fighters_v2 WHERE is_stub = 1")
      ).c,
      fights: (await get(db, "SELECT COUNT(*) as c FROM fights_v2")).c,
      rounds: (await get(db, "SELECT COUNT(*) as c FROM fight_rounds_v2")).c,
      round_stats: (
        await get(db, "SELECT COUNT(*) as c FROM fight_round_stats_v2")
      ).c,
      sig_strikes: (
        await get(db, "SELECT COUNT(*) as c FROM fight_round_sig_strikes_v2")
      ).c,
      totals: (await get(db, "SELECT COUNT(*) as c FROM fight_totals_v2")).c,
    };
    console.log(counts);

    // Success/failure summary
    console.log(`\n[SUMMARY]`);
    console.log(`  ✅ Successful: ${results.successful.length} fighters`);
    results.successful.forEach((r) => {
      console.log(`     - ${r.name}: ${r.fights} fights`);
    });

    if (results.failed.length > 0) {
      console.log(`  ❌ Failed: ${results.failed.length} fighters`);
      results.failed.forEach((r) => {
        console.log(`     - ${r.url}: ${r.error}`);
      });
    }

    console.log(
      "\n✅ Pipeline complete! Run 'node enrich_fighter_stubs.js' to merge stubs."
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

module.exports = { ingestFight, upsertFighter };

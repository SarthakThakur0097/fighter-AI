// production_odds_scraper.js
// Full production scraper to fetch betting odds for all fighters and save to database
// Usage: node production_odds_scraper.js

const axios = require("axios");
const cheerio = require("cheerio");
const { openDb, run, get, all } = require("../db/connection");
const crypto = require("crypto");

// ---- Config -----------------------------------------------------------------
const DB_PATH = process.env.DB_PATH || "mma_fighters.db";
const RATE_LIMIT_MS = 3000; // 3 seconds between requests
const BATCH_SIZE = 50; // Process 50 fighters at a time, then checkpoint

// ---- BestFightOdds Scraping -------------------------------------------------

async function searchBestFightOdds(fighterName) {
  const searchUrl = `https://www.bestfightodds.com/search?query=${encodeURIComponent(
    fighterName,
  )}`;

  try {
    const response = await axios.get(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const $ = cheerio.load(response.data);

    // Find fighter links in search results
    const fighterLinks = [];
    $("table.content-list tr").each((i, row) => {
      const link = $(row).find("a").attr("href");
      const name = $(row).find("a").text().trim();

      if (link && link.includes("/fighters/")) {
        fighterLinks.push({ name, url: link });
      }
    });

    // Find exact match (case-insensitive)
    const exactMatch = fighterLinks.find(
      (f) => f.name.toLowerCase() === fighterName.toLowerCase(),
    );

    if (exactMatch) {
      return `https://www.bestfightodds.com${exactMatch.url}`;
    }

    // If no exact match, return first result (might be close)
    if (fighterLinks.length > 0) {
      return `https://www.bestfightodds.com${fighterLinks[0].url}`;
    }

    return null;
  } catch (error) {
    console.error(`  ⚠️ Search error for ${fighterName}: ${error.message}`);
    return null;
  }
}

async function scrapeFighterOdds(fighterUrl, fighterName) {
  try {
    const response = await axios.get(fighterUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const $ = cheerio.load(response.data);
    const fights = [];

    // Parse the odds table
    const rows = $("table.team-stats-table tbody tr").toArray();

    // Skip mobile event headers, process in pairs
    for (let i = 0; i < rows.length; i++) {
      const row = $(rows[i]);

      // Skip mobile-only event headers
      if (row.hasClass("item-mobile-only-row")) {
        continue;
      }

      // Process main-row (fighter's row)
      if (row.hasClass("main-row")) {
        const nextRow = $(rows[i + 1]);

        // Extract fighter name
        const mainFighterName = row.find("th.oppcell a").text().trim();
        const opponentName = nextRow.find("th.oppcell a").text().trim();

        // Extract event info from first row
        const eventLink = row.find("td.item-non-mobile a");
        const eventName = eventLink.length > 0 ? eventLink.text().trim() : "";
        const eventUrl = eventLink.length > 0 ? eventLink.attr("href") : "";

        // Extract date from second row
        const dateText = nextRow
          .find("td.item-non-mobile")
          .last()
          .text()
          .trim();

        // Extract odds for main fighter
        const mainOdds = extractOddsFromRow(row);

        // Extract odds for opponent
        const oppOdds = extractOddsFromRow(nextRow);

        fights.push({
          event: eventName,
          eventUrl: eventUrl,
          date: dateText,
          mainFighter: mainFighterName,
          mainOdds: mainOdds,
          opponent: opponentName,
          opponentOdds: oppOdds,
        });

        i++; // Skip the next row since we just processed it
      }
    }

    // Filter out future/unconfirmed fights (ONLY HISTORICAL FIGHTS)
    const historicalFights = fights.filter((fight) => {
      // Skip if no date
      if (!fight.date || fight.date.trim() === "") return false;

      // Skip if event name contains "Future" or "Unconfirmed"
      const eventLower = fight.event.toLowerCase();
      if (eventLower.includes("future") || eventLower.includes("unconfirmed"))
        return false;

      // Skip if date is in the future
      const parsedDate = parseDate(fight.date);
      const fightDate = new Date(parsedDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (fightDate >= today) return false;

      return true;
    });

    return historicalFights;
  } catch (error) {
    console.error(`  ⚠️ Scrape error for ${fighterName}: ${error.message}`);
    return [];
  }
}

function extractOddsFromRow(row) {
  const oddsSpans = row.find("td.moneyline span");

  if (oddsSpans.length >= 3) {
    return {
      open: parseOdds(oddsSpans.eq(0).text().trim()),
      closeLow: parseOdds(oddsSpans.eq(1).text().trim()),
      closeHigh: parseOdds(oddsSpans.eq(2).text().trim()),
    };
  }

  return { open: null, closeLow: null, closeHigh: null };
}

function parseOdds(oddsStr) {
  // Convert odds string to number (e.g., "-150" -> -150, "+200" -> 200)
  if (!oddsStr || oddsStr === "" || oddsStr === "-") return null;
  const num = parseInt(oddsStr.replace(/[^0-9-+]/g, ""));
  return isNaN(num) ? null : num;
}

function parseDate(dateStr) {
  // Convert "Feb 1st 2026" to "2026-02-01"
  try {
    const months = {
      jan: "01",
      feb: "02",
      mar: "03",
      apr: "04",
      may: "05",
      jun: "06",
      jul: "07",
      aug: "08",
      sep: "09",
      oct: "10",
      nov: "11",
      dec: "12",
    };

    const match = dateStr.match(/([A-Za-z]+)\s+(\d+)[a-z]*\s+(\d{4})/);
    if (match) {
      const month = months[match[1].toLowerCase().substring(0, 3)];
      const day = match[2].padStart(2, "0");
      const year = match[3];
      return `${year}-${month}-${day}`;
    }
  } catch (e) {
    // Return as-is if parsing fails
  }

  return dateStr;
}

// ---- Database Operations ----------------------------------------------------

async function matchFightInDb(db, fighterId, opponentName, fightDate) {
  // Find fights within ±1 day with this fighter
  const dbFights = await all(
    db,
    `SELECT f.fight_id, f.event_name, f.event_date,
            f1.fighter_id as fighter_1_id, f1.name as fighter_1_name,
            f2.fighter_id as fighter_2_id, f2.name as fighter_2_name,
            ff1.corner as f1_corner, ff2.corner as f2_corner
     FROM fights_v2 f
     JOIN fight_fighters_v2 ff1 ON f.fight_id = ff1.fight_id AND ff1.corner = 'fighter_1'
     JOIN fight_fighters_v2 ff2 ON f.fight_id = ff2.fight_id AND ff2.corner = 'fighter_2'
     JOIN fighters_v2 f1 ON ff1.fighter_id = f1.fighter_id
     JOIN fighters_v2 f2 ON ff2.fighter_id = f2.fighter_id
     WHERE (ff1.fighter_id = ? OR ff2.fighter_id = ?)
       AND ABS(JULIANDAY(f.event_date) - JULIANDAY(?)) <= 1
     LIMIT 10`,
    [fighterId, fighterId, fightDate],
  );

  // Match by opponent name
  const match = dbFights.find((dbFight) => {
    const f1Match =
      dbFight.fighter_1_name.toLowerCase() === opponentName.toLowerCase();
    const f2Match =
      dbFight.fighter_2_name.toLowerCase() === opponentName.toLowerCase();
    return f1Match || f2Match;
  });

  if (!match) return null;

  // Determine which corner the scraped fighter is in
  const scrapedFighterIsF1 = match.fighter_1_id === fighterId;

  return {
    fight_id: match.fight_id,
    event_name: match.event_name,
    event_date: match.event_date,
    scrapedFighterCorner: scrapedFighterIsF1 ? "fighter_1" : "fighter_2",
    fighter_1_name: match.fighter_1_name,
    fighter_2_name: match.fighter_2_name,
  };
}

async function saveOddsToDb(db, fightMatch, scrapedFight) {
  const oddsId = `${fightMatch.fight_id}:bestfightodds`;

  // Determine odds based on which corner the scraped fighter is in
  let f1_open, f1_close_low, f1_close_high;
  let f2_open, f2_close_low, f2_close_high;

  if (fightMatch.scrapedFighterCorner === "fighter_1") {
    // Scraped fighter is fighter_1
    f1_open = scrapedFight.mainOdds.open;
    f1_close_low = scrapedFight.mainOdds.closeLow;
    f1_close_high = scrapedFight.mainOdds.closeHigh;
    f2_open = scrapedFight.opponentOdds.open;
    f2_close_low = scrapedFight.opponentOdds.closeLow;
    f2_close_high = scrapedFight.opponentOdds.closeHigh;
  } else {
    // Scraped fighter is fighter_2
    f1_open = scrapedFight.opponentOdds.open;
    f1_close_low = scrapedFight.opponentOdds.closeLow;
    f1_close_high = scrapedFight.opponentOdds.closeHigh;
    f2_open = scrapedFight.mainOdds.open;
    f2_close_low = scrapedFight.mainOdds.closeLow;
    f2_close_high = scrapedFight.mainOdds.closeHigh;
  }

  // Insert or replace (in case we scrape same fight from both fighters)
  await run(
    db,
    `INSERT OR REPLACE INTO fight_odds (
      odds_id, fight_id, source, source_event_name,
      fighter_1_open, fighter_1_close_low, fighter_1_close_high,
      fighter_2_open, fighter_2_close_low, fighter_2_close_high,
      scraped_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      oddsId,
      fightMatch.fight_id,
      "bestfightodds",
      scrapedFight.event,
      f1_open,
      f1_close_low,
      f1_close_high,
      f2_open,
      f2_close_low,
      f2_close_high,
    ],
  );
}

// ---- Progress Tracking ------------------------------------------------------

async function initProgressTracking(db) {
  // Create progress table if it doesn't exist
  await run(
    db,
    `
    CREATE TABLE IF NOT EXISTS odds_scrape_progress (
      fighter_id TEXT PRIMARY KEY,
      fighter_name TEXT NOT NULL,
      status TEXT NOT NULL,
      fights_found INTEGER DEFAULT 0,
      odds_saved INTEGER DEFAULT 0,
      scraped_at TEXT,
      error TEXT
    )
  `,
  );
}

async function markFighterComplete(
  db,
  fighterId,
  fighterName,
  fightsFound,
  oddsSaved,
  error = null,
) {
  await run(
    db,
    `INSERT OR REPLACE INTO odds_scrape_progress 
     (fighter_id, fighter_name, status, fights_found, odds_saved, scraped_at, error)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
    [
      fighterId,
      fighterName,
      error ? "error" : "complete",
      fightsFound,
      oddsSaved,
      error,
    ],
  );
}

// ---- Main Production Scraper ------------------------------------------------

async function scrapeAllOdds() {
  console.log("=".repeat(80));
  console.log("PRODUCTION ODDS SCRAPER - ALL FIGHTERS (WITH RESUME SUPPORT)");
  console.log("=".repeat(80));

  const db = openDb(DB_PATH);

  try {
    // Initialize progress tracking
    await initProgressTracking(db);

    // Get already scraped fighters
    const completed = await all(
      db,
      `SELECT fighter_id FROM odds_scrape_progress WHERE status IN ('complete', 'error')`,
    );
    const completedIds = new Set(completed.map((r) => r.fighter_id));

    // Get all non-stub fighters
    const allFighters = await all(
      db,
      `SELECT fighter_id, name 
       FROM fighters_v2 
       WHERE is_stub = 0
       ORDER BY name`,
    );

    // Filter out already completed
    const fighters = allFighters.filter((f) => !completedIds.has(f.fighter_id));

    console.log(`\nTotal fighters: ${allFighters.length}`);
    console.log(`Already scraped: ${completedIds.size}`);
    console.log(`Remaining: ${fighters.length}\n`);

    if (fighters.length === 0) {
      console.log("✅ All fighters already scraped!");
      return;
    }

    let totalProcessed = 0;
    let totalFightsScraped = 0;
    let totalOddsSaved = 0;
    let fightersNotFound = 0;
    let fightersWithNoOdds = 0;

    for (let i = 0; i < fighters.length; i++) {
      const fighter = fighters[i];
      const progress = `[${i + 1}/${fighters.length}]`;

      console.log(`\n${progress} ${fighter.name}`);
      console.log("-".repeat(80));

      // Step 1: Search for fighter on BestFightOdds
      const fighterUrl = await searchBestFightOdds(fighter.name);

      if (!fighterUrl) {
        console.log(`  ❌ Not found on BestFightOdds`);
        fightersNotFound++;
        await markFighterComplete(
          db,
          fighter.fighter_id,
          fighter.name,
          0,
          0,
          "Not found on BestFightOdds",
        );
        totalProcessed++;
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      console.log(`  ✅ Found on BestFightOdds`);

      // Step 2: Scrape fighter's odds
      const fights = await scrapeFighterOdds(fighterUrl, fighter.name);

      if (fights.length === 0) {
        console.log(`  ⚠️ No historical fights with odds`);
        fightersWithNoOdds++;
        await markFighterComplete(db, fighter.fighter_id, fighter.name, 0, 0);
        totalProcessed++;
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      console.log(`  📊 Found ${fights.length} historical fights with odds`);
      totalFightsScraped += fights.length;

      // Step 3: Match and save each fight
      let savedCount = 0;
      let matchedCount = 0;

      for (const fight of fights) {
        const parsedDate = parseDate(fight.date);
        const fightMatch = await matchFightInDb(
          db,
          fighter.fighter_id,
          fight.opponent,
          parsedDate,
        );

        if (fightMatch) {
          matchedCount++;
          await saveOddsToDb(db, fightMatch, fight);
          savedCount++;
        }
      }

      console.log(
        `  💾 Saved odds for ${savedCount}/${fights.length} fights (${matchedCount} matched)`,
      );
      totalOddsSaved += savedCount;
      totalProcessed++;

      // Mark fighter as complete
      await markFighterComplete(
        db,
        fighter.fighter_id,
        fighter.name,
        fights.length,
        savedCount,
      );

      // Checkpoint every BATCH_SIZE fighters
      if ((i + 1) % BATCH_SIZE === 0) {
        console.log(`\n${"=".repeat(80)}`);
        console.log(
          `CHECKPOINT: ${i + 1}/${fighters.length} remaining fighters processed`,
        );
        console.log(
          `Total completed (all time): ${completedIds.size + i + 1}/${
            allFighters.length
          }`,
        );
        console.log(`Total odds saved this session: ${totalOddsSaved}`);
        console.log(`${"=".repeat(80)}\n`);
      }

      // Rate limiting
      await sleep(RATE_LIMIT_MS);
    }

    // Final summary
    console.log("\n" + "=".repeat(80));
    console.log("SCRAPING SESSION COMPLETE");
    console.log("=".repeat(80));
    console.log(`Fighters processed this session: ${totalProcessed}`);
    console.log(
      `Total fighters completed (all time): ${
        completedIds.size + totalProcessed
      }/${allFighters.length}`,
    );
    console.log(`Fighters not found on BestFightOdds: ${fightersNotFound}`);
    console.log(`Fighters with no historical odds: ${fightersWithNoOdds}`);
    console.log(`Total fights scraped this session: ${totalFightsScraped}`);
    console.log(`Total odds records saved this session: ${totalOddsSaved}`);
    console.log(
      `Match rate: ${
        totalFightsScraped > 0
          ? ((totalOddsSaved / totalFightsScraped) * 100).toFixed(1)
          : 0
      }%`,
    );

    if (completedIds.size + totalProcessed < allFighters.length) {
      const remaining =
        allFighters.length - (completedIds.size + totalProcessed);
      console.log(
        `\n⚠️ ${remaining} fighters remaining. Run script again to resume.`,
      );
    } else {
      console.log(`\n✅ ALL FIGHTERS COMPLETE!`);
    }
    console.log("=".repeat(80));
  } catch (error) {
    console.error("\n❌ FATAL ERROR:", error);
    throw error;
  } finally {
    db.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Run Scraper ------------------------------------------------------------

if (require.main === module) {
  scrapeAllOdds().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { scrapeAllOdds };

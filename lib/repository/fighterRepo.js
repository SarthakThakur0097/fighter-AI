const { run, get } = require("../db/connection");
const { parsePct } = require("../jobs/ufcstats_scraper_enhanced");

const { normalizeName, parseFloatSafe, fighterIdFromUrl } = require("../utils");

async function upsertFighter(db, data) {
  const fighter_id = fighterIdFromUrl(data.source_url);
  if (!fighter_id) throw new Error("No fighter_id from URL");

  const name = normalizeName(data.name);

  // Check if a stub exists for this fighter by name
  const existingStub = await get(
    db,
    `SELECT fighter_id FROM fighters_v2 WHERE LOWER(TRIM(name)) = LOWER(?) AND is_stub = 1`,
    [name],
  );

  if (existingStub) {
    console.log(`  → Upgrading stub for ${name}`);

    try {
      const oldStubId = existingStub.fighter_id;

      // Temporarily disable FK checks for this upgrade
      await run(db, "PRAGMA foreign_keys = OFF");
      await run(db, "BEGIN TRANSACTION");

      // Step 1: Update all foreign key references to point to the new ID
      await run(
        db,
        `UPDATE fight_fighters_v2 SET fighter_id = ? WHERE fighter_id = ?`,
        [fighter_id, oldStubId],
      );
      await run(
        db,
        `UPDATE fight_round_stats_v2 SET fighter_id = ? WHERE fighter_id = ?`,
        [fighter_id, oldStubId],
      );
      await run(
        db,
        `UPDATE fight_round_sig_strikes_v2 SET fighter_id = ? WHERE fighter_id = ?`,
        [fighter_id, oldStubId],
      );
      await run(
        db,
        `UPDATE fight_totals_v2 SET fighter_id = ? WHERE fighter_id = ?`,
        [fighter_id, oldStubId],
      );

      // Step 2: Delete the old stub
      await run(db, `DELETE FROM fighters_v2 WHERE fighter_id = ?`, [
        oldStubId,
      ]);

      // Step 3: Insert the new complete fighter record
      await run(
        db,
        `INSERT INTO fighters_v2 (fighter_id, name, nickname, dob, height, weight, reach, stance, record,
          slpm, str_acc, sapm, str_def, td_avg, td_acc, td_def, sub_avg, source_url, is_stub)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          fighter_id,
          data.name,
          data.nickname,
          data.dob,
          data.height,
          data.weight,
          data.reach,
          data.stance,
          data.record,
          parseFloatSafe(data.slpm),
          parsePct(data.str_acc),
          parseFloatSafe(data.sapm),
          parsePct(data.str_def),
          parseFloatSafe(data.td_avg),
          parsePct(data.td_acc),
          parsePct(data.td_def),
          parseFloatSafe(data.sub_avg),
          data.source_url,
        ],
      );

      await run(db, "COMMIT");
      // Re-enable FK checks
      await run(db, "PRAGMA foreign_keys = ON");
    } catch (error) {
      await run(db, "ROLLBACK");
      await run(db, "PRAGMA foreign_keys = ON"); // Re-enable even on error
      throw error;
    }
  } else {
    // No stub exists, proceed with normal insert/update
    await run(
      db,
      `INSERT OR IGNORE INTO fighters_v2 (fighter_id, name, nickname, dob, height, weight, reach, stance, record,
        slpm, str_acc, sapm, str_def, td_avg, td_acc, td_def, sub_avg, source_url, is_stub)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        fighter_id,
        data.name,
        data.nickname,
        data.dob,
        data.height,
        data.weight,
        data.reach,
        data.stance,
        data.record,
        parseFloatSafe(data.slpm),
        parsePct(data.str_acc),
        parseFloatSafe(data.sapm),
        parsePct(data.str_def),
        parseFloatSafe(data.td_avg),
        parsePct(data.td_acc),
        parsePct(data.td_def),
        parseFloatSafe(data.sub_avg),
        data.source_url,
      ],
    );

    await run(
      db,
      `UPDATE fighters_v2 SET name=?, nickname=?, dob=?, height=?, weight=?, reach=?, stance=?, record=?,
        slpm=?, str_acc=?, sapm=?, str_def=?, td_avg=?, td_acc=?, td_def=?, sub_avg=?, updated_at=CURRENT_TIMESTAMP
       WHERE fighter_id=?`,
      [
        data.name,
        data.nickname,
        data.dob,
        data.height,
        data.weight,
        data.reach,
        data.stance,
        data.record,
        parseFloatSafe(data.slpm),
        parsePct(data.str_acc),
        parseFloatSafe(data.sapm),
        parsePct(data.str_def),
        parseFloatSafe(data.td_avg),
        parsePct(data.td_acc),
        parsePct(data.td_def),
        parseFloatSafe(data.sub_avg),
        fighter_id,
      ],
    );
  }

  return fighter_id;
}

module.exports = { upsertFighter };

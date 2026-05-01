const { normalizeName } = require("../utils");

async function ingestFight(db, fight, mainFighterId) {
  const fight_id = fightIdFromUrl(fight.fight_url);
  if (!fight_id) {
    console.warn("Skipping fight - no ID:", fight.event);
    return;
  }

  console.log(`  Processing: ${fight.event}`);

  // Insert fight metadata
  await run(
    db,
    `INSERT OR IGNORE INTO fights_v2 (fight_id, fight_details_url, event_name, event_date, weight_class, method, ending_round, ending_time, time_format, referee)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fight_id,
      fight.fight_url,
      fight.event,
      formatEventDate(fight.event_date),
      fight.details?.weight_class || null,
      fight.method || null,
      fight.round ? parseInt(fight.round) : null,
      fight.time || null,
      fight.details?.time_format || null,
      fight.details?.referee || null,
    ]
  );

  // Check if this fight already has fighters assigned
  const existingFighters = await all(
    db,
    `SELECT fighter_id, corner FROM fight_fighters_v2 WHERE fight_id = ?`,
    [fight_id]
  );

  // If fight already has 2 fighters, don't re-process
  if (existingFighters.length >= 2) {
    console.log(`  → Fight already has both fighters assigned, skipping`);

    // Still process stats if this is a stub upgrade
    const mainFighterEntry = existingFighters.find(
      (ef) => ef.fighter_id === mainFighterId
    );
    if (mainFighterEntry) {
      const mainCorner = mainFighterEntry.corner;

      // Process per-round stats if available
      if (
        fight.details?.per_round_stats &&
        Array.isArray(fight.details.per_round_stats)
      ) {
        for (const roundData of fight.details.per_round_stats) {
          await ingestRoundStats(
            db,
            fight_id,
            roundData,
            mainFighterId,
            mainCorner
          );
        }
      }

      // Process significant strikes per round
      if (
        fight.details?.sig_strikes_per_round &&
        Array.isArray(fight.details.sig_strikes_per_round)
      ) {
        for (const roundData of fight.details.sig_strikes_per_round) {
          await ingestSigStrikesRound(
            db,
            fight_id,
            roundData,
            mainFighterId,
            mainCorner
          );
        }
      }

      // Process fight totals
      if (
        fight.details?.totals &&
        Array.isArray(fight.details.totals) &&
        fight.details.totals.length > 0
      ) {
        await ingestFightTotals(
          db,
          fight_id,
          fight.details.totals[0],
          mainFighterId,
          mainCorner
        );
      }
    }

    return;
  }

  // Determine both fighters
  const fighter1Name =
    fight.fighters?.[0] || normalizeName(fight.details?.fighters?.[0]) || "";
  const fighter2Name =
    fight.fighters?.[1] || normalizeName(fight.details?.fighters?.[1]) || "";

  const mainName = normalizeName(
    (
      await get(db, "SELECT name FROM fighters_v2 WHERE fighter_id = ?", [
        mainFighterId,
      ])
    )?.name || ""
  );

  // Determine corners
  let mainCorner, oppCorner;

  if (existingFighters.length === 1) {
    // One fighter already exists, put main fighter in the other corner
    const existingCorner = existingFighters[0].corner;
    if (existingFighters[0].fighter_id === mainFighterId) {
      // Main fighter is already in the fight, use their existing corner
      mainCorner = existingCorner;
      oppCorner = existingCorner === "fighter_1" ? "fighter_2" : "fighter_1";
    } else {
      // Opponent is already in the fight, put main in the other corner
      mainCorner = existingCorner === "fighter_1" ? "fighter_2" : "fighter_1";
      oppCorner = existingCorner;
    }
  } else {
    // No fighters yet, determine from names
    const isF1Main =
      mainName && fighter1Name.toLowerCase() === mainName.toLowerCase();
    mainCorner = isF1Main ? "fighter_1" : "fighter_2";
    oppCorner = isF1Main ? "fighter_2" : "fighter_1";
  }

  // Insert main fighter participation
  await run(
    db,
    `INSERT OR REPLACE INTO fight_fighters_v2 (fight_id, fighter_id, corner, result)
     VALUES (?, ?, ?, ?)`,
    [fight_id, mainFighterId, mainCorner, fight.result]
  );

  // Insert opponent (stub if needed)
  const oppName = mainCorner === "fighter_1" ? fighter2Name : fighter1Name;
  if (oppName) {
    // Check if opponent already exists for this fight
    const existingOpp = existingFighters.find(
      (ef) => ef.fighter_id !== mainFighterId
    );

    let oppId;
    if (existingOpp) {
      oppId = existingOpp.fighter_id;
    } else {
      // Check if a real fighter with this name exists
      const realFighter = await get(
        db,
        `SELECT fighter_id FROM fighters_v2 WHERE LOWER(TRIM(name)) = LOWER(?) AND is_stub = 0 LIMIT 1`,
        [oppName.trim()]
      );

      if (realFighter) {
        oppId = realFighter.fighter_id;
      } else {
        // Check if stub already exists for this name
        const existingStub = await get(
          db,
          `SELECT fighter_id FROM fighters_v2 WHERE LOWER(TRIM(name)) = LOWER(?) AND is_stub = 1 LIMIT 1`,
          [oppName.trim()]
        );

        if (existingStub) {
          oppId = existingStub.fighter_id;
        } else {
          // Create new stub
          oppId = `stub:${require("crypto")
            .createHash("sha1")
            .update(oppName.toLowerCase())
            .digest("hex")}`;
          await run(
            db,
            `INSERT OR IGNORE INTO fighters_v2 (fighter_id, name, is_stub) VALUES (?, ?, 1)`,
            [oppId, oppName]
          );
        }
      }
    }

    const oppResult =
      fight.result === "win"
        ? "loss"
        : fight.result === "loss"
        ? "win"
        : fight.result;

    await run(
      db,
      `INSERT OR REPLACE INTO fight_fighters_v2 (fight_id, fighter_id, corner, result)
       VALUES (?, ?, ?, ?)`,
      [fight_id, oppId, oppCorner, oppResult]
    );
  }

  // Process per-round stats if available
  if (
    fight.details?.per_round_stats &&
    Array.isArray(fight.details.per_round_stats)
  ) {
    for (const roundData of fight.details.per_round_stats) {
      await ingestRoundStats(
        db,
        fight_id,
        roundData,
        mainFighterId,
        mainCorner
      );
    }
  }

  // Process significant strikes per round
  if (
    fight.details?.sig_strikes_per_round &&
    Array.isArray(fight.details.sig_strikes_per_round)
  ) {
    for (const roundData of fight.details.sig_strikes_per_round) {
      await ingestSigStrikesRound(
        db,
        fight_id,
        roundData,
        mainFighterId,
        mainCorner
      );
    }
  }

  // Process fight totals
  if (
    fight.details?.totals &&
    Array.isArray(fight.details.totals) &&
    fight.details.totals.length > 0
  ) {
    await ingestFightTotals(
      db,
      fight_id,
      fight.details.totals[0],
      mainFighterId,
      mainCorner
    );
  }
}
async function ingestRoundStats(
  db,
  fight_id,
  roundData,
  mainFighterId,
  mainCorner
) {
  const round_id = `${fight_id}:${roundData.round}`;

  // Ensure round exists
  await run(
    db,
    `INSERT OR IGNORE INTO fight_rounds_v2 (round_id, fight_id, round_number) VALUES (?, ?, ?)`,
    [round_id, fight_id, roundData.round]
  );

  // Data format: [[fighter1_name, fighter2_name], [kd1, kd2], [sig_str1, sig_str2], ...]
  const data = roundData.data;
  if (!data || data.length < 10) return;

  // Get main fighter's name from database
  const mainFighterName = normalizeName(
    (
      await get(db, "SELECT name FROM fighters_v2 WHERE fighter_id = ?", [
        mainFighterId,
      ])
    )?.name || ""
  );

  if (!mainFighterName) {
    console.warn(`  ⚠️ Could not find fighter name for ID: ${mainFighterId}`);
    return;
  }

  // Find which index in data array matches the main fighter
  const fighter1Name = normalizeName(data[0][0] || "");
  const fighter2Name = normalizeName(data[0][1] || "");

  let mainIdx;
  if (fighter1Name.toLowerCase() === mainFighterName.toLowerCase()) {
    mainIdx = 0;
  } else if (fighter2Name.toLowerCase() === mainFighterName.toLowerCase()) {
    mainIdx = 1;
  } else {
    console.warn(
      `  ⚠️ Fighter name mismatch: ${mainFighterName} not in [${fighter1Name}, ${fighter2Name}]`
    );
    return;
  }

  // Parse main fighter stats using the correct index
  const kd = parseInt(data[1][mainIdx]) || 0;
  const sigStr = parseOfStr(data[2][mainIdx]);
  const totalStr = parseOfStr(data[4][mainIdx]);
  const td = parseOfStr(data[5][mainIdx]);
  const sub = parseInt(data[7][mainIdx]) || 0;
  const rev = parseInt(data[8][mainIdx]) || 0;
  const ctrl = parseCtrlTime(data[9][mainIdx]);

  await run(
    db,
    `INSERT OR REPLACE INTO fight_round_stats_v2 
     (round_id, fighter_id, knockdowns, sig_str_landed, sig_str_attempted, total_str_landed, total_str_attempted, td_landed, td_attempted, sub_attempts, reversals, ctrl_time, ctrl_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      round_id,
      mainFighterId,
      kd,
      sigStr.landed,
      sigStr.attempted,
      totalStr.landed,
      totalStr.attempted,
      td.landed,
      td.attempted,
      sub,
      rev,
      ctrl.time,
      ctrl.seconds,
    ]
  );
}
async function ingestSigStrikesRound(
  db,
  fight_id,
  roundData,
  mainFighterId,
  mainCorner
) {
  const round_id = `${fight_id}:${roundData.round}`;

  // Data format: [[fighter1_name, fighter2_name], [sig1, sig2], [pct1, pct2], [head1, head2], [body1, body2], [leg1, leg2], [dist1, dist2], [clinch1, clinch2], [ground1, ground2]]
  const data = roundData.data;
  if (!data || data.length < 9) return;

  // Get main fighter's name from database
  const mainFighterName = normalizeName(
    (
      await get(db, "SELECT name FROM fighters_v2 WHERE fighter_id = ?", [
        mainFighterId,
      ])
    )?.name || ""
  );

  if (!mainFighterName) {
    console.warn(`  ⚠️ Could not find fighter name for ID: ${mainFighterId}`);
    return;
  }

  // Find which index in data array matches the main fighter
  const fighter1Name = normalizeName(data[0][0] || "");
  const fighter2Name = normalizeName(data[0][1] || "");

  let mainIdx;
  if (fighter1Name.toLowerCase() === mainFighterName.toLowerCase()) {
    mainIdx = 0;
  } else if (fighter2Name.toLowerCase() === mainFighterName.toLowerCase()) {
    mainIdx = 1;
  } else {
    console.warn(
      `  ⚠️ Fighter name mismatch: ${mainFighterName} not in [${fighter1Name}, ${fighter2Name}]`
    );
    return;
  }

  const head = parseOfStr(data[3][mainIdx]);
  const body = parseOfStr(data[4][mainIdx]);
  const leg = parseOfStr(data[5][mainIdx]);
  const distance = parseOfStr(data[6][mainIdx]);
  const clinch = parseOfStr(data[7][mainIdx]);
  const ground = parseOfStr(data[8][mainIdx]);

  await run(
    db,
    `INSERT OR REPLACE INTO fight_round_sig_strikes_v2 
     (round_id, fighter_id, head_landed, head_attempted, body_landed, body_attempted, leg_landed, leg_attempted, distance_landed, distance_attempted, clinch_landed, clinch_attempted, ground_landed, ground_attempted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      round_id,
      mainFighterId,
      head.landed,
      head.attempted,
      body.landed,
      body.attempted,
      leg.landed,
      leg.attempted,
      distance.landed,
      distance.attempted,
      clinch.landed,
      clinch.attempted,
      ground.landed,
      ground.attempted,
    ]
  );
}
async function ingestFightTotals(
  db,
  fight_id,
  totalsData,
  mainFighterId,
  mainCorner
) {
  // Data format: [[fighter1_name, fighter2_name], [kd1, kd2], [sig1, sig2], [pct1, pct2], [total1, total2], [td1, td2], [td_pct1, td_pct2], [sub1, sub2], [rev1, rev2], [ctrl1, ctrl2]]
  if (!totalsData || totalsData.length < 10) return;

  // Get main fighter's name from database
  const mainFighterName = normalizeName(
    (
      await get(db, "SELECT name FROM fighters_v2 WHERE fighter_id = ?", [
        mainFighterId,
      ])
    )?.name || ""
  );

  if (!mainFighterName) {
    console.warn(`  ⚠️ Could not find fighter name for ID: ${mainFighterId}`);
    return;
  }

  // Find which index in data array matches the main fighter
  const fighter1Name = normalizeName(totalsData[0][0] || "");
  const fighter2Name = normalizeName(totalsData[0][1] || "");

  let mainIdx;
  if (fighter1Name.toLowerCase() === mainFighterName.toLowerCase()) {
    mainIdx = 0;
  } else if (fighter2Name.toLowerCase() === mainFighterName.toLowerCase()) {
    mainIdx = 1;
  } else {
    console.warn(
      `  ⚠️ Fighter name mismatch: ${mainFighterName} not in [${fighter1Name}, ${fighter2Name}]`
    );
    return;
  }

  const kd = parseInt(totalsData[1][mainIdx]) || 0;
  const sigStr = parseOfStr(totalsData[2][mainIdx]);
  const totalStr = parseOfStr(totalsData[4][mainIdx]);
  const td = parseOfStr(totalsData[5][mainIdx]);
  const sub = parseInt(totalsData[7][mainIdx]) || 0;
  const rev = parseInt(totalsData[8][mainIdx]) || 0;
  const ctrl = parseCtrlTime(totalsData[9][mainIdx]);

  await run(
    db,
    `INSERT OR REPLACE INTO fight_totals_v2 
     (fight_id, fighter_id, knockdowns, sig_str_landed, sig_str_attempted, total_str_landed, total_str_attempted, td_landed, td_attempted, sub_attempts, reversals, ctrl_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fight_id,
      mainFighterId,
      kd,
      sigStr.landed,
      sigStr.attempted,
      totalStr.landed,
      totalStr.attempted,
      td.landed,
      td.attempted,
      sub,
      rev,
      ctrl.seconds,
    ]
  );
}

module.exports = { ingestFight, ingestRoundStats, ingestSigStrikesRound, ingestFightTotals };

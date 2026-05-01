// ufc_data_repo_sqlite3.js
// Uses your existing ./database.js connection (sqlite3) and adds promise-based query helpers.

const db = require("./database");

// ---- Promise wrappers (no new DB connection) ----
function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

// ---- Repo functions ----
async function getFightRoundsPaired(fightId) {
  // Full fight, round-by-round, with both fighters side-by-side from fighter_fight_round_sig_breakdown_v2
  const sql = `
    WITH base AS (
      SELECT
        round_id,
        substr(round_id, 1, instr(round_id, ':') - 1) AS fight_id,
        CAST(substr(round_id, instr(round_id, ':') + 1) AS INTEGER) AS round_num,
        fighter_id,

        sig_landed, sig_attempted, sig_pct,
        head_landed, head_attempted,
        body_landed, body_attempted,
        leg_landed, leg_attempted,
        distance_landed, distance_attempted,
        clinch_landed, clinch_attempted,
        ground_landed, ground_attempted
      FROM fighter_fight_round_sig_breakdown_v2
    ),
    paired AS (
      SELECT
        b1.fight_id,
        b1.round_num,

        b1.fighter_id AS fighter_a_id,
        b1.sig_landed AS a_sig_landed,
        b1.sig_attempted AS a_sig_attempted,
        b1.sig_pct AS a_sig_pct,
        b1.head_landed AS a_head_landed,
        b1.head_attempted AS a_head_attempted,
        b1.body_landed AS a_body_landed,
        b1.body_attempted AS a_body_attempted,
        b1.leg_landed AS a_leg_landed,
        b1.leg_attempted AS a_leg_attempted,
        b1.distance_landed AS a_distance_landed,
        b1.distance_attempted AS a_distance_attempted,
        b1.clinch_landed AS a_clinch_landed,
        b1.clinch_attempted AS a_clinch_attempted,
        b1.ground_landed AS a_ground_landed,
        b1.ground_attempted AS a_ground_attempted,

        b2.fighter_id AS fighter_b_id,
        b2.sig_landed AS b_sig_landed,
        b2.sig_attempted AS b_sig_attempted,
        b2.sig_pct AS b_sig_pct,
        b2.head_landed AS b_head_landed,
        b2.head_attempted AS b_head_attempted,
        b2.body_landed AS b_body_landed,
        b2.body_attempted AS b_body_attempted,
        b2.leg_landed AS b_leg_landed,
        b2.leg_attempted AS b_leg_attempted,
        b2.distance_landed AS b_distance_landed,
        b2.distance_attempted AS b_distance_attempted,
        b2.clinch_landed AS b_clinch_landed,
        b2.clinch_attempted AS b_clinch_attempted,
        b2.ground_landed AS b_ground_landed,
        b2.ground_attempted AS b_ground_attempted
      FROM base b1
      JOIN base b2
        ON b1.fight_id = b2.fight_id
       AND b1.round_num = b2.round_num
       AND b1.fighter_id < b2.fighter_id
    )
    SELECT *
    FROM paired
    WHERE fight_id = ?
    ORDER BY round_num;
  `;

  return allAsync(sql, [fightId]);
}

async function getFighterRoundRows(fighterId) {
  const sql = `
    SELECT *
    FROM fighter_fight_round_sig_breakdown_v2
    WHERE fighter_id = ?
    ORDER BY
      substr(round_id, 1, instr(round_id, ':') - 1),
      CAST(substr(round_id, instr(round_id, ':') + 1) AS INTEGER);
  `;
  return allAsync(sql, [fighterId]);
}

async function getFightRoundRowsRaw(fightId) {
  // Returns both fighters' rows for the fight (not paired)
  const sql = `
    SELECT
      round_id,
      fighter_id,
      sig_landed, sig_attempted, sig_pct,
      head_landed, head_attempted,
      body_landed, body_attempted,
      leg_landed, leg_attempted,
      distance_landed, distance_attempted,
      clinch_landed, clinch_attempted,
      ground_landed, ground_attempted
    FROM fighter_fight_round_sig_breakdown_v2
    WHERE substr(round_id, 1, instr(round_id, ':') - 1) = ?
    ORDER BY
      CAST(substr(round_id, instr(round_id, ':') + 1) AS INTEGER),
      fighter_id;
  `;
  return allAsync(sql, [fightId]);
}

async function getTableInfo(tableName) {
  // Note: tableName is interpolated; keep it internal (don’t pass user input blindly)
  const sql = `PRAGMA table_info(${tableName});`;
  return allAsync(sql);
}

module.exports = {
  // wrappers (useful elsewhere)
  allAsync,
  getAsync,
  runAsync,

  // repo queries
  getFightRoundsPaired,
  getFighterRoundRows,
  getFightRoundRowsRaw,
  getTableInfo,
};

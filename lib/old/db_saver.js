// db_saver.js
const db = require("./database");

function saveFighterToDB(fighter) {
  return new Promise((resolve, reject) => {
    const insertQuery = `
  INSERT OR IGNORE INTO fighters (
    name, nickname, age, height, weight, reach, image_url,
    wins_total, losses_total, draws_total,
    wins_tko, wins_sub, losses_tko, losses_sub
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
`;

    const values = [
      fighter.name,
      fighter.nickname,
      parseInt(fighter.age) || null,
      fighter.height,
      fighter.weight,
      fighter.reach,
      fighter.image_url,
      fighter.wins_total,
      fighter.losses_total,
      fighter.draws_total,
      fighter.wins_tko,
      fighter.wins_sub,
      fighter.losses_tko,
      fighter.losses_sub,
    ];

    db.run(insertQuery, values, function (err) {
      if (err) {
        console.error("❌ Error inserting fighter:", err.message);
        reject(err);
      } else {
        console.log(`✅ Fighter ${fighter.name} saved with ID ${this.lastID}`);
        if (this.lastID) {
          resolve(this.lastID);
        } else {
          db.get(
            "SELECT id FROM fighters WHERE name = ?",
            [fighter.name],
            (err, row) => {
              if (err) return reject(err);
              resolve(row?.id);
            }
          );
        }
      }
    });
  });
}

function saveFightHistoryToDB(fighterId, fights) {
  return new Promise((resolve, reject) => {
    if (!fights || !Array.isArray(fights)) return resolve();

    const stmt = db.prepare(`
    INSERT INTO fights (
      fighter_id, event_date, opponent, result, event_name,
      sdbl_a, sdhl_a, sdll_a, tsl, tsa, ssl, ssa, tsl_tsa, kd,
      body_pct, head_pct, leg_pct,
      scbl, scba, schl, scha, scll, scla, rv, sr,
      tdl, tda, tds, tk_acc,
      sgbl, sgba, sghl, sgha, sgll, sgla,
      ad, adtb, adhg, adtm, adts, sm
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

    db.serialize(() => {
      fights.forEach((f) => {
        // 🪵 DEBUG – see what date fields we’re about to insert
        console.log("🗓  Saving fight →", {
          event_date: f.event_date,
          date: f.date,              // what the scraper called it
          opponent: f.opponent,
          result: f.result
        });

        const values = [
          fighterId,
          f.date ?? null,      // DB expects event_date
          f.opponent ?? null,
          f.result ?? null,
          f.event_name ?? null,
          f.sdbl_a ?? null,
          f.sdhl_a ?? null,
          f.sdll_a ?? null,
          f.tsl ?? null,
          f.tsa ?? null,
          f.ssl ?? null,
          f.ssa ?? null,
          f.tsl_tsa ?? null,
          f.kd ?? null,
          f.body_pct ?? null,
          f.head_pct ?? null,
          f.leg_pct ?? null,

          f.scbl ?? null,
          f.scba ?? null,
          f.schl ?? null,
          f.scha ?? null,
          f.scll ?? null,
          f.scla ?? null,
          f.rv ?? null,
          f.sr ?? null,

          f.tdl ?? null,
          f.tda ?? null,
          f.tds ?? null,
          f.tk_acc ?? null,

          f.sgbl ?? null,
          f.sgba ?? null,
          f.sghl ?? null,
          f.sgha ?? null,
          f.sgll ?? null,
          f.sgla ?? null,

          f.ad ?? null,
          f.adtb ?? null,
          f.adhg ?? null,
          f.adtm ?? null,
          f.adts ?? null,
          f.sm ?? null,
        ];

        stmt.run(values);
      });

      stmt.finalize((err) => {
        if (err) {
          console.error(
            `❌ Failed to save fight history for fighter ID ${fighterId}:`,
            err.message
          );
          reject(err);
        } else {
          console.log(
            `✅ Saved ${fights.length} fights for fighter ID ${fighterId}`
          );
          resolve();
        }
      });
    });
  });
}

function initializeTables() {
  db.serialize(() => {
    db.run("DROP TABLE IF EXISTS fights;");
    db.run("DROP TABLE IF EXISTS fighters;");
    db.run(`
      CREATE TABLE IF NOT EXISTS fighters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        nickname TEXT,
        age TEXT,
        height TEXT,
        weight TEXT,
        reach TEXT,
        image_url TEXT,
        record TEXT,
        wins_total INTEGER,
        losses_total INTEGER,
        draws_total INTEGER,
        wins_tko INTEGER,
        losses_tko INTEGER,
        wins_sub INTEGER,
        losses_sub INTEGER
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS fights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fighter_id INTEGER,
        event_date TEXT,
        opponent TEXT,
        result TEXT,
        event_name TEXT,

        sdbl_a TEXT, sdhl_a TEXT, sdll_a TEXT,
        tsl TEXT, tsa TEXT, ssl TEXT, ssa TEXT,
        tsl_tsa TEXT, kd TEXT,
        body_pct TEXT, head_pct TEXT, leg_pct TEXT,

        scbl TEXT, scba TEXT, schl TEXT, scha TEXT,
        scll TEXT, scla TEXT, rv TEXT, sr TEXT,
        tdl TEXT, tda TEXT, tds TEXT, tk_acc TEXT,

        sgbl TEXT, sgba TEXT, sghl TEXT, sgha TEXT,
        sgll TEXT, sgla TEXT, ad TEXT, adtb TEXT,
        adhg TEXT, adtm TEXT, adts TEXT, sm TEXT,

        FOREIGN KEY (fighter_id) REFERENCES fighters(id)
      );
    `);

    console.log("✅ ESPN schema tables initialized.");
  });
}

module.exports = {
  saveFighterToDB,
  saveFightHistoryToDB,
  initializeTables,
};

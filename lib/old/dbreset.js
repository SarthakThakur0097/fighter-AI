const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./mma_fighters.db");

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
      wins_total INTEGER,
      losses_total INTEGER,
      draws_total INTEGER,
      wins_tko INTEGER,
      wins_sub INTEGER,
      losses_tko INTEGER,
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

  console.log("✅ Tables dropped and recreated.");
});

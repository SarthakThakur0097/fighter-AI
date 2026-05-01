const sqlite3 = require("sqlite3").verbose();

// Create a new database connection
const db = new sqlite3.Database("./mma_fighters.db", (err) => {
  if (err) {
    console.error("Error opening database:", err.message);
  } else {
    console.log("Connected to the SQLite database.");
  }
});

function initializeTables() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS fighters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        nickname TEXT,
        age INTEGER,
        height TEXT,
        weight TEXT,
        reach TEXT,
        image_url TEXT,
        wins INTEGER,
        losses INTEGER,
        draws INTEGER,
        kos INTEGER,
        subs INTEGER,
        ko_losses INTEGER,
        sub_losses INTEGER
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS fights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fighter_id INTEGER,
        event_name TEXT,
        event_date TEXT,
        result TEXT,
        opponent TEXT,
        SDBLA TEXT,
        SDHLA TEXT,
        SDLLA TEXT,
        TSL TEXT,
        TSA TEXT,
        SSL TEXT,
        SSA TEXT,
        TSLTSA TEXT,
        KD TEXT,
        BODY_PERCENT TEXT,
        HEAD_PERCENT TEXT,
        LEG_PERCENT TEXT,
        SCBL TEXT,
        SCBA TEXT,
        SCHL TEXT,
        SCHA TEXT,
        SCLL TEXT,
        SCLA TEXT,
        RV TEXT,
        SR TEXT,
        TDL TEXT,
        TDA TEXT,
        TDS TEXT,
        TKACC TEXT,
        SGBL TEXT,
        SGBA TEXT,
        SGHL TEXT,
        SGHA TEXT,
        SGLL TEXT,
        SGLA TEXT,
        AD TEXT,
        ADTB TEXT,
        ADHG TEXT,
        ADTM TEXT,
        ADTS TEXT,
        SM TEXT,
        FOREIGN KEY(fighter_id) REFERENCES fighters(id)
      );
    `);

    console.log("✅ Tables initialized successfully.");
  });
}

function dropAndRecreateTables() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("DROP TABLE IF EXISTS fights", (err) => {
        if (err) return reject(err);
        db.run("DROP TABLE IF EXISTS fighters", (err) => {
          if (err) return reject(err);
          initializeTables();
          resolve();
        });
      });
    });
  });
}

function resetDatabase() {
  db.serialize(() => {
    db.run("DROP TABLE IF EXISTS fights");
    db.run("DROP TABLE IF EXISTS fighters", (err) => {
      if (err) {
        console.error("❌ Error dropping tables:", err.message);
      } else {
        console.log("🧹 Existing tables dropped.");
        initializeTables();
      }
    });
  });
}

module.exports = db;
module.exports.resetDatabase = resetDatabase;
module.exports.dropAndRecreateTables = dropAndRecreateTables;

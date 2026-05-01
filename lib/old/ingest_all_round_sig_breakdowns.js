/**
 * Ingest per-round Significant Strike breakdowns (Head/Body/Leg + Distance/Clinch/Ground)
 * for all fights in fights_v2.
 *
 * IMPORTANT FIXES (Jan 2026):
 * 1) Do NOT rely on fighter links inside the per-round sig tables (often missing).
 *    Instead, extract the 2 participant fighter_ids from the fight-details page once,
 *    then assign rows by row order (A then B) when a link is absent.
 * 2) Reprocess fights that are "incomplete" (i.e., any round_id has != 2 fighter rows),
 *    not just fights with zero rows.
 * 3) Placeholder count fixed (17 columns => 17 placeholders).
 *
 * Run:
 *   node ingest_all_round_sig_breakdowns.js
 */

const db = require("./database");
const cheerio = require("cheerio");

// ---------------- sqlite helpers ----------------
function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes });
    });
  });
}

// ---------------- net helpers ----------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function toHttp(url) {
  return (url || "").replace(/^https:\/\//i, "http://");
}
async function fetchHtml(url, { retries = 6, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(toHttp(url), {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      const backoff = 350 * Math.pow(2, attempt - 1);
      console.warn(
        `[fetch] ${attempt}/${retries} failed: ${e.message} | backoff ${backoff}ms`
      );
      await sleep(backoff);
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

// ---------------- parsing helpers ----------------
function extractFighterIdFromHref(href) {
  const m = /\/fighter-details\/([a-f0-9]{16})/i.exec(href || "");
  return m ? m[1] : null;
}

/**
 * Pull the two participant fighter IDs from the fight-details page.
 * This is far more reliable than expecting links inside each round table row.
 */
function getFightParticipantIds($) {
  const ids = [];
  $('a[href*="/fighter-details/"]').each((_, a) => {
    const href = $(a).attr("href");
    const id = extractFighterIdFromHref(href);
    if (id && !ids.includes(id)) ids.push(id);
  });
  return ids.slice(0, 2);
}

// Cell formats seen:
//  - "30 of 46 65%"
//  - "30 of 46"
//  - "--"
function parseLandedAttemptedPct(text) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t || t === "--") return { landed: null, attempted: null, pct: null };

  // "X of Y Z%"
  let m = /^(\d+)\s+of\s+(\d+)\s+(\d+)%$/i.exec(t);
  if (m)
    return {
      landed: Number(m[1]),
      attempted: Number(m[2]),
      pct: Number(m[3]) / 100,
    };

  // "X of Y"
  m = /^(\d+)\s+of\s+(\d+)$/i.exec(t);
  if (m) return { landed: Number(m[1]), attempted: Number(m[2]), pct: null };

  // Single number (rare)
  m = /^(\d+)$/i.exec(t);
  if (m) return { landed: Number(m[1]), attempted: null, pct: null };

  return { landed: null, attempted: null, pct: null };
}

/**
 * UFCStats fight-details pages include per-round "Significant Strikes" breakdown tables.
 * We find tables whose headers include:
 *  Fighter | Sig. Str. | Head | Body | Leg | Distance | Clinch | Ground
 *
 * Returns rows like:
 *  { round_id: "fightId:round", fighter_id, sig_landed,...ground_attempted, sig_pct }
 */
function parseSigBreakdownsFromFightDetails(html, fightId) {
  const $ = cheerio.load(html);

  // ---------------- helpers ----------------
  function extractFighterIdFromHref(href) {
    const m = /\/fighter-details\/([a-f0-9]{16})/i.exec(href || "");
    return m ? m[1] : null;
  }

  function parseLandedAttemptedPct(text) {
    const t = (text || "").replace(/\s+/g, " ").trim();
    if (!t || t === "--" || t === "-")
      return { landed: null, attempted: null, pct: null };

    // "X of Y Z%"
    let m = /^(\d+)\s+of\s+(\d+)\s+(\d+)%$/i.exec(t);
    if (m)
      return {
        landed: Number(m[1]),
        attempted: Number(m[2]),
        pct: Number(m[3]) / 100,
      };

    // "X of Y"
    m = /^(\d+)\s+of\s+(\d+)$/i.exec(t);
    if (m) return { landed: Number(m[1]), attempted: Number(m[2]), pct: null };

    // "X/Y"
    m = /^(\d+)\s*\/\s*(\d+)$/i.exec(t);
    if (m) return { landed: Number(m[1]), attempted: Number(m[2]), pct: null };

    // bare number
    m = /^(\d+)$/i.exec(t);
    if (m) return { landed: Number(m[1]), attempted: null, pct: null };

    return { landed: null, attempted: null, pct: null };
  }

  function getFightParticipantIds() {
    // Preferred: top-of-page fighter links (most reliable)
    const topIds = $(".b-fight-details__persons a[href*='/fighter-details/']")
      .map((_, a) => extractFighterIdFromHref($(a).attr("href")))
      .get()
      .filter(Boolean);

    if (topIds.length >= 2) return [topIds[0], topIds[1]];

    // Fallback: first two unique fighter links anywhere
    const anyIds = $("a[href*='/fighter-details/']")
      .map((_, a) => extractFighterIdFromHref($(a).attr("href")))
      .get()
      .filter(Boolean);

    const uniq = [];
    for (const id of anyIds) if (!uniq.includes(id)) uniq.push(id);
    return uniq.length >= 2 ? [uniq[0], uniq[1]] : [null, null];
  }

  function getTwoLinesFromCell($cell) {
    // Most common: two <p> tags (top fighter, bottom fighter)
    const ps = $cell
      .find("p")
      .map((_, p) => $(p).text().replace(/\s+/g, " ").trim())
      .get()
      .filter(Boolean);

    if (ps.length >= 2) return [ps[0], ps[1]];

    // Fallback: split by newlines
    const raw = $cell.text().replace(/\r/g, "\n").replace(/\n+/g, "\n").trim();
    const parts = raw
      .split("\n")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    if (parts.length >= 2) return [parts[0], parts[1]];

    return [null, null];
  }

  function tableLooksLikeSigBreakdown($table) {
    const headers = $table
      .find("thead th")
      .map((_, th) => $(th).text().replace(/\s+/g, " ").trim().toLowerCase())
      .get();

    const need = [
      "fighter",
      "sig. str",
      "head",
      "body",
      "leg",
      "distance",
      "clinch",
      "ground",
    ];
    return need.every((k) => headers.some((h) => h.includes(k)));
  }

  function findRoundNumberForTable(tableEl) {
    // Search nearby text for "Round X"
    const probes = [
      $(tableEl).prevAll().slice(0, 10),
      $(tableEl).parent().prevAll().slice(0, 10),
      $(tableEl).closest("section,div").prevAll().slice(0, 10),
    ];

    for (const p of probes) {
      for (const node of p.toArray()) {
        const txt = $(node).text().replace(/\s+/g, " ").trim();
        const m = /round\s+(\d+)/i.exec(txt);
        if (m) return Number(m[1]);
      }
    }
    return null;
  }

  // ---------------- main ----------------
  const [fighterA, fighterB] = getFightParticipantIds();
  const hasParticipants = !!(fighterA && fighterB);

  const out = [];
  let fallbackRound = 1;

  $("table").each((_, tableEl) => {
    const $table = $(tableEl);
    if (!tableLooksLikeSigBreakdown($table)) return;

    let roundNumber = findRoundNumberForTable(tableEl);
    if (!roundNumber) roundNumber = fallbackRound++;

    // Collect rows for this table
    const fighterRows = [];

    $table.find("tbody tr").each((_, tr) => {
      const $tr = $(tr);
      const $tds = $tr.find("td");
      if ($tds.length < 8) return;

      // Detect stacked row (one <tr> contains both fighters)
      const fighterLinks = $tr.find("a[href*='/fighter-details/']");
      const looksStacked =
        fighterLinks.length >= 2 || $($tds.get(0)).find("p").length >= 2;

      if (looksStacked) {
        if (!hasParticipants) return;

        // Build [top, bottom] text for each of the 8 cells
        const cellPairs = [];
        for (let c = 0; c < 8; c++) {
          cellPairs.push(getTwoLinesFromCell($($tds.get(c))));
        }

        const A_sig = parseLandedAttemptedPct(cellPairs[1][0]);
        const A_head = parseLandedAttemptedPct(cellPairs[2][0]);
        const A_body = parseLandedAttemptedPct(cellPairs[3][0]);
        const A_leg = parseLandedAttemptedPct(cellPairs[4][0]);
        const A_dist = parseLandedAttemptedPct(cellPairs[5][0]);
        const A_clin = parseLandedAttemptedPct(cellPairs[6][0]);
        const A_grnd = parseLandedAttemptedPct(cellPairs[7][0]);

        const B_sig = parseLandedAttemptedPct(cellPairs[1][1]);
        const B_head = parseLandedAttemptedPct(cellPairs[2][1]);
        const B_body = parseLandedAttemptedPct(cellPairs[3][1]);
        const B_leg = parseLandedAttemptedPct(cellPairs[4][1]);
        const B_dist = parseLandedAttemptedPct(cellPairs[5][1]);
        const B_clin = parseLandedAttemptedPct(cellPairs[6][1]);
        const B_grnd = parseLandedAttemptedPct(cellPairs[7][1]);

        fighterRows.push({
          fighter_id: fighterA,
          sig_landed: A_sig.landed,
          sig_attempted: A_sig.attempted,
          sig_pct: A_sig.pct,
          head_landed: A_head.landed,
          head_attempted: A_head.attempted,
          body_landed: A_body.landed,
          body_attempted: A_body.attempted,
          leg_landed: A_leg.landed,
          leg_attempted: A_leg.attempted,
          distance_landed: A_dist.landed,
          distance_attempted: A_dist.attempted,
          clinch_landed: A_clin.landed,
          clinch_attempted: A_clin.attempted,
          ground_landed: A_grnd.landed,
          ground_attempted: A_grnd.attempted,
        });

        fighterRows.push({
          fighter_id: fighterB,
          sig_landed: B_sig.landed,
          sig_attempted: B_sig.attempted,
          sig_pct: B_sig.pct,
          head_landed: B_head.landed,
          head_attempted: B_head.attempted,
          body_landed: B_body.landed,
          body_attempted: B_body.attempted,
          leg_landed: B_leg.landed,
          leg_attempted: B_leg.attempted,
          distance_landed: B_dist.landed,
          distance_attempted: B_dist.attempted,
          clinch_landed: B_clin.landed,
          clinch_attempted: B_clin.attempted,
          ground_landed: B_grnd.landed,
          ground_attempted: B_grnd.attempted,
        });

        return; // done with this tr
      }

      // Two-row layout: one fighter per <tr>, BUT row 2 often has no link.
      let fighterId = null;
      const link = $tr.find("a[href*='/fighter-details/']").first();
      fighterId = extractFighterIdFromHref(link.attr("href"));

      // If missing link, fall back to row order within THIS table (A then B)
      if (!fighterId) {
        if (!hasParticipants) return;
        fighterId = fighterRows.length === 0 ? fighterA : fighterB;
      }

      const cols = $tds
        .map((_, td) => $(td).text().replace(/\s+/g, " ").trim())
        .get();

      const sig = parseLandedAttemptedPct(cols[1]);
      const head = parseLandedAttemptedPct(cols[2]);
      const body = parseLandedAttemptedPct(cols[3]);
      const leg = parseLandedAttemptedPct(cols[4]);
      const dist = parseLandedAttemptedPct(cols[5]);
      const clin = parseLandedAttemptedPct(cols[6]);
      const grnd = parseLandedAttemptedPct(cols[7]);

      fighterRows.push({
        fighter_id: fighterId,
        sig_landed: sig.landed,
        sig_attempted: sig.attempted,
        sig_pct: sig.pct,
        head_landed: head.landed,
        head_attempted: head.attempted,
        body_landed: body.landed,
        body_attempted: body.attempted,
        leg_landed: leg.landed,
        leg_attempted: leg.attempted,
        distance_landed: dist.landed,
        distance_attempted: dist.attempted,
        clinch_landed: clin.landed,
        clinch_attempted: clin.attempted,
        ground_landed: grnd.landed,
        ground_attempted: grnd.attempted,
      });
    });

    // Emit rows (if we got at least 1 fighter row)
    for (const r of fighterRows) {
      out.push({
        round_id: `${fightId}:${roundNumber}`,
        fighter_id: r.fighter_id,
        sig_landed: r.sig_landed,
        sig_attempted: r.sig_attempted,
        sig_pct: r.sig_pct,
        head_landed: r.head_landed,
        head_attempted: r.head_attempted,
        body_landed: r.body_landed,
        body_attempted: r.body_attempted,
        leg_landed: r.leg_landed,
        leg_attempted: r.leg_attempted,
        distance_landed: r.distance_landed,
        distance_attempted: r.distance_attempted,
        clinch_landed: r.clinch_landed,
        clinch_attempted: r.clinch_attempted,
        ground_landed: r.ground_landed,
        ground_attempted: r.ground_attempted,
      });
    }
  });

  return out;
}

// ---------------- main ingest loop ----------------
(async () => {
  console.log("Connected to the SQLite database.");

  /**
   * We want to process:
   * - fights with ZERO rows in the round table, OR
   * - fights where ANY round_id has != 2 fighter rows (incomplete rounds)
   */
  const fightsToDo = await allAsync(`
    WITH bad_fights AS (
      SELECT DISTINCT substr(round_id, 1, instr(round_id,':')-1) AS fight_id
      FROM (
        SELECT round_id
        FROM fighter_fight_round_sig_breakdown_v2
        GROUP BY round_id
        HAVING COUNT(*) <> 2
      )
    )
    SELECT
      f.fight_id,
      COALESCE(f.fight_details_url, 'http://ufcstats.com/fight-details/' || f.fight_id) AS url
    FROM fights_v2 f
    LEFT JOIN (
      SELECT DISTINCT substr(round_id, 1, instr(round_id,':')-1) AS fight_id
      FROM fighter_fight_round_sig_breakdown_v2
    ) r ON r.fight_id = f.fight_id
    LEFT JOIN bad_fights b ON b.fight_id = f.fight_id
    WHERE r.fight_id IS NULL OR b.fight_id IS NOT NULL
    ORDER BY f.event_date ASC;
  `);

  console.log(`[round-ingest] fights to (re)process: ${fightsToDo.length}`);

  const POLITE_DELAY_MS = 175; // adjust if needed
  const LOG_EVERY = 50;

  let ok = 0;
  let fail = 0;
  let inserted = 0;

  for (let i = 0; i < fightsToDo.length; i++) {
    const { fight_id, url } = fightsToDo[i];

    try {
      await sleep(POLITE_DELAY_MS);
      const html = await fetchHtml(url);

      const rows = parseSigBreakdownsFromFightDetails(html, fight_id);

      if (!rows.length) {
        console.warn(
          `[round-ingest] no sig breakdown tables found for fight ${fight_id}`
        );
        ok++;
        continue;
      }

      for (const r of rows) {
        const res = await runAsync(
          `
          INSERT OR IGNORE INTO fighter_fight_round_sig_breakdown_v2 (
            round_id, fighter_id,
            sig_landed, sig_attempted, sig_pct,
            head_landed, head_attempted,
            body_landed, body_attempted,
            leg_landed, leg_attempted,
            distance_landed, distance_attempted,
            clinch_landed, clinch_attempted,
            ground_landed, ground_attempted
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);
          `,
          [
            r.round_id,
            r.fighter_id,
            r.sig_landed,
            r.sig_attempted,
            r.sig_pct,
            r.head_landed,
            r.head_attempted,
            r.body_landed,
            r.body_attempted,
            r.leg_landed,
            r.leg_attempted,
            r.distance_landed,
            r.distance_attempted,
            r.clinch_landed,
            r.clinch_attempted,
            r.ground_landed,
            r.ground_attempted,
          ]
        );
        inserted += res.changes;
      }

      ok++;
    } catch (e) {
      fail++;
      console.warn(`[round-ingest] fight ${fight_id} failed: ${e.message}`);
    }

    if ((i + 1) % LOG_EVERY === 0) {
      console.log(
        `[progress] ${i + 1}/${
          fightsToDo.length
        } | ok=${ok} fail=${fail} inserted=${inserted}`
      );
    }
  }

  console.log(
    `[done] fights processed=${fightsToDo.length} | ok=${ok} fail=${fail} inserted=${inserted}`
  );

  // Coverage summary
  const coverage = await allAsync(`
    SELECT
      (SELECT COUNT(*) FROM fights_v2) AS total_fights,
      (SELECT COUNT(DISTINCT substr(round_id, 1, instr(round_id,':')-1)) FROM fighter_fight_round_sig_breakdown_v2) AS fights_with_rounds,
      (SELECT COUNT(*) FROM fighter_fight_round_sig_breakdown_v2) AS round_rows,
      (SELECT COUNT(*) FROM (
        SELECT round_id
        FROM fighter_fight_round_sig_breakdown_v2
        GROUP BY round_id
        HAVING COUNT(*) <> 2
      )) AS bad_round_ids
  `);
  console.log("[coverage]", coverage[0]);

  process.exit(0);
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

// ufcstats_scraper_enhanced.js
// Enhanced scraper using native Node.js fetch + cheerio
// npm i cheerio

const cheerio = require("cheerio");

/**
 * Parse "X of Y" format into object
 */
function parseOfStr(str) {
  const m = /(\d+)\s+of\s+(\d+)/i.exec(String(str || ""));
  if (!m) return { landed: null, attempted: null };
  return { landed: parseInt(m[1]), attempted: parseInt(m[2]) };
}

/**
 * Parse percentage string to decimal
 */
function parsePct(pctStr) {
  const m = /([\d.]+)\s*%/.exec(String(pctStr || ""));
  if (!m) return null;
  const v = parseFloat(m[1]);
  return isFinite(v) ? v / 100 : null;
}

/**
 * Parse control time to seconds
 */
function parseCtrlTime(timeStr) {
  const str = String(timeStr || "").trim();
  if (!str || str === "---" || str === "--") return { time: null, seconds: null };
  
  const m = /(\d+):(\d+)/.exec(str);
  if (!m) return { time: str, seconds: null };
  
  const minutes = parseInt(m[1]);
  const seconds = parseInt(m[2]);
  return {
    time: str,
    seconds: minutes * 60 + seconds
  };
}

/**
 * Fetch HTML content
 */
async function fetchHTML(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  return await response.text();
}

/**
 * Extract fighter profile data
 */
function parseFighterProfile(html) {
  const $ = cheerio.load(html);
  
  const getText = (selector) => $(selector).first().text().trim();
  
  const getCareerStat = (label) => {
    let value = null;
    $(".b-list__box-list-item").each((i, el) => {
      const text = $(el).text();
      if (text.includes(label + ":")) {
        value = text.split(":")[1]?.trim() || null;
      }
    });
    return value;
  };

  return {
    name: getText(".b-content__title-highlight"),
    nickname: getText(".b-content__Nickname"),
    record: getText(".b-content__title-record").replace("Record:", "").trim(),
    
    // Physical attributes
    height: getCareerStat("Height"),
    weight: getCareerStat("Weight"),
    reach: getCareerStat("Reach"),
    stance: getCareerStat("STANCE"),
    dob: getCareerStat("DOB"),
    
    // Career stats
    slpm: getCareerStat("SLpM"),
    str_acc: getCareerStat("Str. Acc."),
    sapm: getCareerStat("SApM"),
    str_def: getCareerStat("Str. Def"),
    td_avg: getCareerStat("TD Avg."),
    td_acc: getCareerStat("TD Acc."),
    td_def: getCareerStat("TD Def."),
    sub_avg: getCareerStat("Sub. Avg."),
  };
}

/**
 * Extract fight list from profile page
 */
function parseFightList(html) {
  const $ = cheerio.load(html);
  const fights = [];
  
  $(".b-fight-details__table-row").each((i, row) => {
    if (i === 0) return; // Skip header
    
    const $row = $(row);
    const fightUrl = $row.attr("data-link");
    if (!fightUrl) return;
    
    const cols = $row.find(".b-fight-details__table-col");
    if (cols.length < 10) return;
    
    const getText = (idx) => {
      return $(cols[idx]).find("p").map((i, el) => $(el).text().trim()).get();
    };
    
    fights.push({
      fight_url: fightUrl,
      result: $(cols[0]).text().trim().toLowerCase(),
      fighters: getText(1),
      kd: getText(2),
      str: getText(3),
      td: getText(4),
      sub: getText(5),
      event: $(cols[6]).find("a").text().trim(),
      event_date: $(cols[6]).find("p").eq(1).text().trim(),
      method: $(cols[7]).find("p").eq(0).text().trim(),
      method_detail: $(cols[7]).find("p").eq(1).text().trim(),
      round: $(cols[8]).text().trim(),
      time: $(cols[9]).text().trim(),
    });
  });
  
  return fights;
}

/**
 * Extract per-round data from a section with alternating thead/tbody elements
 * This handles the unique HTML structure where rounds are separate tbody elements
 */
function extractPerRoundData($, sectionSelector) {
  const section = $(sectionSelector);
  if (!section.length) return [];
  
  const perRoundData = [];
  
  // Find all round headers (thead elements with class containing "type_head")
  section.find('thead.b-fight-details__table-row_type_head').each((i, thead) => {
    const $thead = $(thead);
    
    // Extract round number
    const roundText = $thead.find('th').text().trim();
    const roundMatch = roundText.match(/Round\s+(\d+)/i);
    if (!roundMatch) return;
    
    const roundNum = parseInt(roundMatch[1]);
    
    // Get the next tbody sibling (contains the data)
    const $tbody = $thead.next('tbody');
    if (!$tbody.length) return;
    
    // Extract data from the row
    const $row = $tbody.find('tr.b-fight-details__table-row').first();
    if (!$row.length) return;
    
    // Get all columns
    const cols = $row.find('td.b-fight-details__table-col');
    const data = [];
    
    cols.each((colIdx, col) => {
      const texts = $(col).find('p').map((j, p) => $(p).text().trim()).get();
      data.push(texts);
    });
    
    if (data.length > 0) {
      perRoundData.push({
        round: roundNum,
        data: data
      });
    }
  });
  
  return perRoundData;
}

/**
 * Extract totals data from a table
 */
function extractTotalsData($, tableSelector) {
  const table = $(tableSelector);
  if (!table.length) return null;
  
  const rows = [];
  table.find('tbody tr.b-fight-details__table-row').each((i, row) => {
    const cols = $(row).find('td.b-fight-details__table-col');
    const data = [];
    
    cols.each((colIdx, col) => {
      const texts = $(col).find('p').map((j, p) => $(p).text().trim()).get();
      data.push(texts);
    });
    
    if (data.length > 0) {
      rows.push(data);
    }
  });
  
  return rows.length > 0 ? rows : null;
}

/**
 * Extract fight details from fight page
 */
function parseFightDetails(html) {
  const $ = cheerio.load(html);
  
  const getText = (selector) => $(selector).first().text().trim();
  
  // Get fighter names
  const fighters = $(".b-fight-details__person-name a").map((i, el) => $(el).text().trim()).get();
  
  // Get fight metadata
  const weight_class = getText(".b-fight-details__fight-title");
  
  const method = $(".b-fight-details__text-item_first")
    .filter((i, el) => $(el).find(".b-fight-details__label").text().includes("Method"))
    .text()
    .replace(/Method:\s*/i, "")
    .trim();
  
  const roundText = $(".b-fight-details__text-item")
    .filter((i, el) => $(el).find(".b-fight-details__label").text().includes("Round"))
    .text();
  const round = roundText.match(/Round:\s*(\d+)/i)?.[1] || null;
  
  const timeText = $(".b-fight-details__text-item")
    .filter((i, el) => $(el).find(".b-fight-details__label").text().includes("Time"))
    .text();
  const time = timeText.match(/Time:\s*(.+)/i)?.[1]?.trim() || null;
  
  const time_format = $(".b-fight-details__text-item")
    .filter((i, el) => $(el).find(".b-fight-details__label").text().includes("Time format"))
    .text()
    .replace(/Time format:\s*/i, "")
    .trim();
  
  const referee = $(".b-fight-details__text-item")
    .filter((i, el) => $(el).find(".b-fight-details__label").text().includes("Referee"))
    .text()
    .replace(/Referee:\s*/i, "")
    .trim();
  
  // Extract Totals table (first table after "Totals" section)
  const totalsSection = $('section.js-fight-section').filter((i, el) => {
    return $(el).find('p.b-fight-details__collapse-link_tot').text().includes('Totals');
  }).first();
  
  const totalsTable = totalsSection.next('section').find('table').first();
  const totals = extractTotalsData($, totalsTable);
  
  // Extract Per-Round Stats (general stats - KD, Str, TD, etc.)
  // This is the FIRST "Per round" section
  const perRoundSection = $('section.js-fight-section').filter((i, el) => {
    const link = $(el).find('a.b-fight-details__collapse-link_rnd');
    if (!link.length) return false;
    
    // Check if this is the first per-round section (has KD, Total str, etc.)
    const headers = $(el).find('th').map((j, th) => $(th).text().trim().toLowerCase()).get();
    return headers.includes('kd') || headers.includes('total str.');
  }).first();
  
  const per_round_stats = extractPerRoundData($, perRoundSection);
  
  // Extract Significant Strikes Total
  const sigStrikesSection = $('section.js-fight-section').filter((i, el) => {
    return $(el).find('p.b-fight-details__collapse-link_tot').text().includes('Significant Strikes');
  }).first();
  
  const sigStrikesTable = sigStrikesSection.next('table').first();
  const sig_strikes_total = extractTotalsData($, sigStrikesTable);
  
  // Extract Significant Strikes Per Round
  // This is the SECOND "Per round" section
  const sigStrikesPerRoundSection = $('section.js-fight-section').filter((i, el) => {
    const link = $(el).find('a.b-fight-details__collapse-link_rnd');
    if (!link.length) return false;
    
    // Check if this is the sig strikes per-round section (has Head, Body, Leg)
    const headers = $(el).find('th').map((j, th) => $(th).text().trim().toLowerCase()).get();
    return headers.includes('head') || headers.includes('body') || headers.includes('leg');
  }).first();
  
  const sig_strikes_per_round = extractPerRoundData($, sigStrikesPerRoundSection);
  
  return {
    fighters,
    weight_class,
    method,
    round,
    time,
    time_format,
    referee,
    totals,
    per_round_stats,
    sig_strikes_total,
    sig_strikes_per_round,
  };
}

/**
 * Scrape complete fighter data including ALL fight details
 */
async function scrapeEnhancedFighterByUrl(url) {
  console.log(`[scraper] Starting: ${url}`);
  
  // Fetch fighter profile
  const profileHTML = await fetchHTML(url);
  const profileData = parseFighterProfile(profileHTML);
  const fightsList = parseFightList(profileHTML);
  
  console.log(`[scraper] Found ${fightsList.length} fights`);
  
  // Scrape detailed stats for each fight
  const fights = [];
  for (let i = 0; i < fightsList.length; i++) {
    const fightSummary = fightsList[i];
    console.log(`[scraper] Fight ${i + 1}/${fightsList.length}: ${fightSummary.event}`);
    
    try {
      const fightHTML = await fetchHTML(fightSummary.fight_url);
      const fightDetails = parseFightDetails(fightHTML);
      
      fights.push({
        ...fightSummary,
        details: fightDetails,
      });
      
      // Be respectful - small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (err) {
      console.error(`[scraper] Error on fight ${i + 1}:`, err.message);
      fights.push({
        ...fightSummary,
        details: null,
        error: err.message,
      });
    }
  }
  
  return {
    ...profileData,
    source_url: url,
    fights,
    scraped_at: new Date().toISOString(),
  };
}

// Export for use in pipeline
module.exports = {
  scrapeEnhancedFighterByUrl,
  parseOfStr,
  parsePct,
  parseCtrlTime,
};

// Test if run directly
if (require.main === module) {
  const testUrl = process.argv[2] || "http://ufcstats.com/fighter-details/07f72a2a7591b409";
  
  scrapeEnhancedFighterByUrl(testUrl)
    .then((data) => {
      console.log("\n[SUCCESS] Scraped data:");
      console.log(JSON.stringify(data, null, 2));
    })
    .catch((err) => {
      console.error("\n[ERROR]", err);
      process.exit(1);
    });
}
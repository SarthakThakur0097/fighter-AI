function normalizeName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFloatSafe(val) {
  if (!val) return null;
  const num = parseFloat(String(val).replace(/[^\d.]/g, ""));
  return isFinite(num) ? num : null;
}

function fighterIdFromUrl(url) {
  const m = /fighter-details\/([a-z0-9]+)/i.exec(String(url || ""));
  return m ? m[1] : null;
}

function fightIdFromUrl(url) {
  const m = /fight-details\/([a-z0-9]+)/i.exec(String(url || ""));
  return m ? m[1] : null;
}

function formatEventDate(dateStr) {
  if (!dateStr) return null;
  try {
    const months = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" };
    const parts = dateStr.replace(/\./g, "").split(/[\s,]+/).filter(Boolean);
    if (parts.length === 3) {
      const month = months[parts[0].toLowerCase()];
      const day = parts[1].padStart(2, "0");
      const year = parts[2];
      return `${year}-${month}-${day}`;
    }
  } catch (e) {
    console.warn("Date parse error:", dateStr, e.message);
  }
  return dateStr;
}

module.exports = { normalizeName, parseFloatSafe, fighterIdFromUrl, fightIdFromUrl, formatEventDate };
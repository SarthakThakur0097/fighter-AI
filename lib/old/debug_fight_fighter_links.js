const axios = require("axios");
const cheerio = require("cheerio");

function fighterIdFromUrl(url) {
  const m = /fighter-details\/([a-z0-9]+)/i.exec(String(url || ""));
  return m ? m[1] : null;
}

async function main() {
  const fightUrl = "http://ufcstats.com/fight-details/0fca825e14429c1f";
  const res = await axios.get(fightUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    },
    timeout: 30000,
  });

  const $ = cheerio.load(res.data);

  const personLinks = $(".b-fight-details__persons a[href*='fighter-details/']")
    .map((_, el) => $(el).attr("href"))
    .get()
    .filter(Boolean);

  const nameLinks = $(".b-fight-details__person-name a[href*='fighter-details/']")
    .map((_, el) => $(el).attr("href"))
    .get()
    .filter(Boolean);

  console.log("\n[persons links]");
  for (const href of personLinks) {
    console.log(" ", fighterIdFromUrl(href), href);
  }

  console.log("\n[name header links]");
  for (const href of nameLinks) {
    console.log(" ", fighterIdFromUrl(href), href);
  }
}

main().catch((e) => {
  console.error("[fatal]", e.message);
  process.exit(1);
});

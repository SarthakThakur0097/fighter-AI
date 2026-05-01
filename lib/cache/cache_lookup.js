// cache_lookup.js
// Helper functions to look up fighters from cache

const fs = require("fs");
const path = require("path");

let cachedData = null;

function loadCache() {
  if (cachedData) return cachedData;
  
  const cachePath = path.join(__dirname, "cache", "fighter_urls.json");
  
  if (!fs.existsSync(cachePath)) {
    console.warn("[cache] No cache found at:", cachePath);
    console.warn("[cache] Run: node build_fighter_cache.js");
    return null;
  }
  
  const raw = fs.readFileSync(cachePath, "utf8");
  cachedData = JSON.parse(raw);
  
  console.log(`[cache] Loaded ${cachedData.total_fighters} fighters from cache`);
  console.log(`[cache] Generated at: ${cachedData.generated_at}`);
  
  return cachedData;
}

function getFighterUrlFromCache(fighterName) {
  const cache = loadCache();
  if (!cache) return null;
  
  const key = fighterName.toLowerCase().trim();
  const url = cache.lookup[key];
  
  if (url) {
    console.log(`[cache] Found ${fighterName} in cache:`, url);
    return url;
  }
  
  // Try fuzzy matching - sometimes names have nicknames or slight variations
  const normalizedSearch = key.replace(/[^a-z0-9]/g, "");
  
  for (const [cachedName, cachedUrl] of Object.entries(cache.lookup)) {
    const normalizedCached = cachedName.replace(/[^a-z0-9]/g, "");
    if (normalizedCached.includes(normalizedSearch) || normalizedSearch.includes(normalizedCached)) {
      console.log(`[cache] Fuzzy matched "${fighterName}" to "${cachedName}"`);
      return cachedUrl;
    }
  }
  
  console.warn(`[cache] No match found for: ${fighterName}`);
  return null;
}

function searchCache(query) {
  const cache = loadCache();
  if (!cache) return [];
  
  const q = query.toLowerCase().trim();
  const results = [];
  
  for (const fighter of cache.fighters) {
    if (fighter.name.toLowerCase().includes(q)) {
      results.push(fighter);
    }
  }
  
  return results;
}

module.exports = {
  loadCache,
  getFighterUrlFromCache,
  searchCache
};
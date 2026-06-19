// ============================================================
//  WC 2026 Fantasy — Auto Score Updater
//  Runs every 10 minutes via GitHub Actions
//  Pulls live scores from football-data.org → writes to Firebase
// ============================================================

const https = require("https");

// ── Config ───────────────────────────────────────────────────
const FOOTBALL_API_KEY  = process.env.FOOTBALL_API_KEY;
const FIREBASE_DB_URL   = "https://sweepstake-world-cup-default-rtdb.firebaseio.com";
const FIREBASE_SECRET   = process.env.FIREBASE_SECRET;
const WC_COMPETITION_ID = "2000"; // football-data.org World Cup ID

// ── Team name mapping (football-data.org → your app names) ───
const NAME_MAP = {
  "Mexico":                    "Mexico",
  "South Africa":              "South Africa",
  "Korea Republic":            "South Korea",
  "South Korea":               "South Korea",
  "Czechia":                   "Czechia",
  "Czech Republic":            "Czechia",
  "Canada":                    "Canada",
  "Bosnia and Herzegovina":    "Bosnia and H'",
  "Bosnia and H'":             "Bosnia and H'",
  "Bosnia-Herzegovina":        "Bosnia and H'",
  "Bosnia & Herzegovina":      "Bosnia and H'",
  "Bosnia":                    "Bosnia and H'",
  "Qatar":                     "Qatar",
  "Switzerland":               "Switzerland",
  "Brazil":                    "Brazil",
  "Morocco":                   "Morocco",
  "Haiti":                     "Haiti",
  "Scotland":                  "Scotland",
  "USA":                       "USA",
  "United States":             "USA",
  "Paraguay":                  "Paraguay",
  "Australia":                 "Australia",
  "Türkiye":                   "Türkiye",
  "Turkey":                    "Türkiye",
  "Germany":                   "Germany",
  "Curaçao":                   "Curaçao",
  "Curacao":                   "Curaçao",
  "Ivory Coast":               "Ivory Coast",
  "Côte d'Ivoire":             "Ivory Coast",
  "Ecuador":                   "Ecuador",
  "Netherlands":               "Netherlands",
  "Japan":                     "Japan",
  "Sweden":                    "Sweden",
  "Tunisia":                   "Tunisia",
  "Belgium":                   "Belgium",
  "Egypt":                     "Egypt",
  "Iran":                      "Iran",
  "IR Iran":                   "Iran",
  "New Zealand":               "New Zealand",
  "Spain":                     "Spain",
  "Cape Verde":                "Cape Verde",
  "Cabo Verde":                "Cape Verde",
  "Cape Verde Islands":        "Cape Verde",
  "Saudi Arabia":              "Saudi Arabia",
  "Uruguay":                   "Uruguay",
  "France":                    "France",
  "Senegal":                   "Senegal",
  "Iraq":                      "Iraq",
  "Norway":                    "Norway",
  "Argentina":                 "Argentina",
  "Algeria":                   "Algeria",
  "Austria":                   "Austria",
  "Jordan":                    "Jordan",
  "Portugal":                  "Portugal",
  "DR Congo":                  "DR Congo",
  "Congo DR":                  "DR Congo",
  "Uzbekistan":                "Uzbekistan",
  "Colombia":                  "Colombia",
  "England":                   "England",
  "Croatia":                   "Croatia",
  "Ghana":                     "Ghana",
  "Panama":                    "Panama",
};

// Safe Firebase key (no special chars)
function safeKey(name) {
  return name.replace(/[.#$[\]']/g, "_");
}

// Fallback fuzzy matcher: strips punctuation/spacing differences so
// API name variants (hyphens vs "and", "Islands" suffix, etc.) still
// resolve correctly even if not explicitly listed in NAME_MAP.
function normalize(str) {
  return (str || "")
    .toLowerCase()
    .replace(/islands?/g, "")
    .replace(/[^a-z]/g, "");
}

const NORMALIZED_LOOKUP = {};
for (const [apiName, appName] of Object.entries(NAME_MAP)) {
  NORMALIZED_LOOKUP[normalize(apiName)] = appName;
}

function resolveTeamName(rawName) {
  if (!rawName) return null;
  if (NAME_MAP[rawName]) return NAME_MAP[rawName];
  const norm = normalize(rawName);
  if (NORMALIZED_LOOKUP[norm]) return NORMALIZED_LOOKUP[norm];
  // Try matching by "and"/"-"/"&" interchangeably for two-word countries
  const withAnd = normalize(rawName.replace(/-/g, " and "));
  if (NORMALIZED_LOOKUP[withAnd]) return NORMALIZED_LOOKUP[withAnd];
  return null;
}

// ── HTTP helpers ─────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("JSON parse error: " + data.slice(0, 200))); }
      });
    }).on("error", reject);
  });
}

function firebaseGet(path) {
  const url = `${FIREBASE_DB_URL}/${path}.json?auth=${FIREBASE_SECRET}`;
  return httpGet(url);
}

function firebasePut(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(`${FIREBASE_DB_URL}/${path}.json?auth=${FIREBASE_SECRET}`);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Round reached mapping ─────────────────────────────────────
// football-data.org stage names → rounds reached count
// NOTE: Group stage does NOT count as a "round reached" for fantasy
// points — that bonus only applies once a team progresses to the
// knockout stages (Round of 32 onwards).
function stageToRounds(stage) {
  const map = {
    "GROUP_STAGE":          0,
    "LAST_32":              1,
    "LAST_16":              2,
    "QUARTER_FINALS":       3,
    "SEMI_FINALS":          4,
    "THIRD_PLACE":          4,
    "FINAL":                5,
  };
  return map[stage] || 0;
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  console.log("🔄 Fetching all WC 2026 matches...");

  // Get all matches
  const matchData = await httpGet(
    `https://api.football-data.org/v4/competitions/${WC_COMPETITION_ID}/matches`,
    { "X-Auth-Token": FOOTBALL_API_KEY }
  );

  if (!matchData.matches) {
    console.error("No matches found:", JSON.stringify(matchData).slice(0, 300));
    process.exit(1);
  }

  console.log(`📊 Processing ${matchData.matches.length} matches...`);

  // Build stats per team
  const stats = {};

  function getStats(teamName) {
    const key = safeKey(teamName);
    if (!stats[key]) {
      stats[key] = {
        wins: 0, draws: 0, losses: 0,
        goalsFor: 0, goalsAgainst: 0,
        redCards: 0, roundsReached: 0,
        semiFinal: 0, wonFinal: 0,
        _name: teamName,
      };
    }
    return stats[key];
  }

  // Track highest round reached per team
  const highestRound = {};

  for (const match of matchData.matches) {
    if (match.status !== "FINISHED") continue;

    const homeRaw = match.homeTeam?.name;
    const awayRaw = match.awayTeam?.name;
    const home = resolveTeamName(homeRaw);
    const away = resolveTeamName(awayRaw);

    if (!home || !away) {
      console.warn(`⚠️  Unknown team: ${homeRaw} or ${awayRaw}`);
      continue;
    }

    const hGoals = match.score?.fullTime?.home ?? 0;
    const aGoals = match.score?.fullTime?.away ?? 0;
    const stage  = match.stage;
    const rounds = stageToRounds(stage);

    // Update highest round reached
    highestRound[safeKey(home)] = Math.max(highestRound[safeKey(home)] || 0, rounds);
    highestRound[safeKey(away)] = Math.max(highestRound[safeKey(away)] || 0, rounds);

    const hStats = getStats(home);
    const aStats = getStats(away);

    // Goals
    hStats.goalsFor     += hGoals;
    hStats.goalsAgainst += aGoals;
    aStats.goalsFor     += aGoals;
    aStats.goalsAgainst += hGoals;

    // Win/draw/loss (handle penalties for knockout rounds)
    const hWin = match.score?.winner === "HOME_TEAM";
    const aWin = match.score?.winner === "AWAY_TEAM";
    const draw = match.score?.winner === "DRAW";

    if (hWin) { hStats.wins++; aStats.losses = (aStats.losses||0) + 1; }
    else if (aWin) { aStats.wins++; hStats.losses = (hStats.losses||0) + 1; }
    else if (draw) { hStats.draws++; aStats.draws++; }

    // Semi-final win
    if (stage === "SEMI_FINALS") {
      if (hWin) hStats.semiFinal++;
      if (aWin) aStats.semiFinal++;
    }

    // Final win
    if (stage === "FINAL") {
      if (hWin) hStats.wonFinal++;
      if (aWin) aStats.wonFinal++;
    }
  }

  // Apply highest rounds reached
  for (const [key, rounds] of Object.entries(highestRound)) {
    if (stats[key]) stats[key].roundsReached = rounds;
  }

  // ── Red cards: never computed or modified by this script ───
  // football-data.org doesn't reliably provide card data, so red
  // cards are managed entirely via the Admin panel. This script
  // simply carries over whatever value is already in Firebase.
  console.log("📥 Reading existing team scores to preserve red cards...");
  let existing = {};
  try {
    existing = (await firebaseGet("teamScores")) || {};
  } catch (e) {
    console.warn("⚠️  Could not read existing scores:", e.message);
  }

  for (const key of Object.keys(stats)) {
    stats[key].redCards = existing[key]?.redCards || 0;
  }

  // Also keep any teams that existed before but had no finished
  // matches yet in this run (shouldn't normally happen, but safe).
  for (const [key, prev] of Object.entries(existing)) {
    if (!stats[key]) stats[key] = prev;
  }

  console.log(`✅ Computed stats for ${Object.keys(stats).length} teams`);
  console.log("Sample:", JSON.stringify(Object.values(stats)[0], null, 2));

  // Write to Firebase
  console.log("🔥 Writing to Firebase...");
  await firebasePut("teamScores", stats);
  console.log("🏆 Done! Firebase updated.");
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});

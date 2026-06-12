// WC 2026 Fantasy — Auto Score Updater
// Pulls finished matches from football-data.org and writes team stats to Firebase.

const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const FIREBASE_SECRET  = process.env.FIREBASE_SECRET;
const FIREBASE_URL     = "https://sweepstake-world-cup-default-rtdb.firebaseio.com";
const COMPETITION_ID   = 2000; // FIFA World Cup

// Maps football-data.org team names -> names used in the app
const NAME_MAP = {
  "Mexico": "Mexico",
  "South Africa": "South Africa",
  "Korea Republic": "South Korea",
  "South Korea": "South Korea",
  "Czech Republic": "Czechia",
  "Czechia": "Czechia",
  "Canada": "Canada",
  "Bosnia and Herzegovina": "Bosnia and H'",
  "Qatar": "Qatar",
  "Switzerland": "Switzerland",
  "Brazil": "Brazil",
  "Morocco": "Morocco",
  "Haiti": "Haiti",
  "Scotland": "Scotland",
  "United States": "USA",
  "USA": "USA",
  "Paraguay": "Paraguay",
  "Australia": "Australia",
  "Turkey": "Türkiye",
  "Türkiye": "Türkiye",
  "Germany": "Germany",
  "Curacao": "Curaçao",
  "Curaçao": "Curaçao",
  "Ivory Coast": "Ivory Coast",
  "Côte d'Ivoire": "Ivory Coast",
  "Ecuador": "Ecuador",
  "Netherlands": "Netherlands",
  "Japan": "Japan",
  "Sweden": "Sweden",
  "Tunisia": "Tunisia",
  "Belgium": "Belgium",
  "Egypt": "Egypt",
  "IR Iran": "Iran",
  "Iran": "Iran",
  "New Zealand": "New Zealand",
  "Spain": "Spain",
  "Cabo Verde": "Cape Verde",
  "Cape Verde": "Cape Verde",
  "Saudi Arabia": "Saudi Arabia",
  "Uruguay": "Uruguay",
  "France": "France",
  "Senegal": "Senegal",
  "Iraq": "Iraq",
  "Norway": "Norway",
  "Argentina": "Argentina",
  "Algeria": "Algeria",
  "Austria": "Austria",
  "Jordan": "Jordan",
  "Portugal": "Portugal",
  "DR Congo": "DR Congo",
  "Congo DR": "DR Congo",
  "Uzbekistan": "Uzbekistan",
  "Colombia": "Colombia",
  "England": "England",
  "Croatia": "Croatia",
  "Ghana": "Ghana",
  "Panama": "Panama",
};

// IMPORTANT: Group stage does NOT count as a "round reached" for fantasy points.
// Rounds reached only counts knockout stage progression beyond the group phase.
const STAGE_TO_ROUNDS = {
  "GROUP_STAGE":    0,
  "LAST_32":        1,
  "LAST_16":        2,
  "QUARTER_FINALS": 3,
  "SEMI_FINALS":    4,
  "THIRD_PLACE":    4, // doesn't add an extra round beyond semis
  "FINAL":          5,
};

function safeKey(name) {
  return name.replace(/[.#$[\]']/g, "_");
}

async function fetchMatches() {
  const res = await fetch(
    `https://api.football-data.org/v4/competitions/${COMPETITION_ID}/matches?status=FINISHED`,
    { headers: { "X-Auth-Token": FOOTBALL_API_KEY } }
  );
  if (!res.ok) throw new Error(`football-data.org error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.matches || [];
}

function mappedName(apiName) {
  return NAME_MAP[apiName] || apiName;
}

function blankStats() {
  return {
    wins: 0, draws: 0, redCards: 0,
    goalsFor: 0, goalsAgainst: 0,
    roundsReached: 0, semiFinal: 0, wonFinal: 0,
  };
}

function computeTeamStats(matches) {
  const stats = {};

  for (const match of matches) {
    const stage = match.stage;
    const home = mappedName(match.homeTeam.name);
    const away = mappedName(match.awayTeam.name);
    const homeScore = match.score?.fullTime?.home ?? 0;
    const awayScore = match.score?.fullTime?.away ?? 0;

    if (!stats[home]) stats[home] = blankStats();
    if (!stats[away]) stats[away] = blankStats();

    // Goals
    stats[home].goalsFor     += homeScore;
    stats[home].goalsAgainst += awayScore;
    stats[away].goalsFor     += awayScore;
    stats[away].goalsAgainst += homeScore;

    // Win / draw
    if (homeScore > awayScore) {
      stats[home].wins += 1;
    } else if (awayScore > homeScore) {
      stats[away].wins += 1;
    } else {
      stats[home].draws += 1;
      stats[away].draws += 1;
    }

    // Rounds reached — only counts if the match itself is a knockout stage match
    // (i.e. the team is confirmed to have REACHED that round by playing in it).
    // Group stage matches contribute 0.
    const roundsForThisStage = STAGE_TO_ROUNDS[stage] ?? 0;
    stats[home].roundsReached = Math.max(stats[home].roundsReached, roundsForThisStage);
    stats[away].roundsReached = Math.max(stats[away].roundsReached, roundsForThisStage);

    // Semi-final win
    if (stage === "SEMI_FINALS") {
      if (homeScore > awayScore) stats[home].semiFinal = 1;
      if (awayScore > homeScore) stats[away].semiFinal = 1;
      // Penalty shootout winner (if regular score level)
      if (homeScore === awayScore && match.score?.penalties) {
        const ph = match.score.penalties.home, pa = match.score.penalties.away;
        if (ph > pa) stats[home].semiFinal = 1;
        if (pa > ph) stats[away].semiFinal = 1;
      }
    }

    // Final win
    if (stage === "FINAL") {
      if (homeScore > awayScore) stats[home].wonFinal = 1;
      if (awayScore > homeScore) stats[away].wonFinal = 1;
      if (homeScore === awayScore && match.score?.penalties) {
        const ph = match.score.penalties.home, pa = match.score.penalties.away;
        if (ph > pa) stats[home].wonFinal = 1;
        if (pa > ph) stats[away].wonFinal = 1;
      }
    }

    // Red cards (if bookings data is available — not guaranteed on free tier)
    if (match.bookings) {
      for (const booking of match.bookings) {
        if (booking.card === "RED") {
          const teamName = mappedName(booking.team?.name || "");
          if (stats[teamName]) stats[teamName].redCards += 1;
        }
      }
    }
  }

  return stats;
}

async function getExistingTeamScores() {
  const res = await fetch(`${FIREBASE_URL}/teamScores.json?auth=${FIREBASE_SECRET}`);
  if (!res.ok) throw new Error(`Firebase read error: ${res.status}`);
  return (await res.json()) || {};
}

async function writeTeamScores(teamScores) {
  const res = await fetch(`${FIREBASE_URL}/teamScores.json?auth=${FIREBASE_SECRET}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(teamScores),
  });
  if (!res.ok) throw new Error(`Firebase write error: ${res.status} ${await res.text()}`);
}

async function main() {
  console.log("Fetching finished matches…");
  const matches = await fetchMatches();
  console.log(`Found ${matches.length} finished matches.`);

  const computed = computeTeamStats(matches);

  console.log("Reading existing team scores (to preserve manual red-card edits)…");
  const existing = await getExistingTeamScores();

  const merged = {};
  for (const [teamName, stats] of Object.entries(computed)) {
    const key = safeKey(teamName);
    const prev = existing[key] || {};
    merged[key] = {
      ...stats,
      // Preserve any manually-entered red card count if the computed value is 0
      // (red cards aren't reliably available from the free API tier).
      redCards: stats.redCards > 0 ? stats.redCards : (prev.redCards || 0),
    };
  }

  // Keep any teams that existed before but had no finished matches yet
  for (const [key, stats] of Object.entries(existing)) {
    if (!merged[key]) merged[key] = stats;
  }

  console.log("Writing updated team scores to Firebase…");
  await writeTeamScores(merged);
  console.log("Done!");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

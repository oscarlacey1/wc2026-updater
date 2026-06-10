# WC 2026 Fantasy — Auto Score Updater

Automatically pulls live World Cup scores from football-data.org every 10 minutes and updates your Firebase leaderboard.

## Setup (5 minutes)

### 1. Create a GitHub repo
- Go to github.com → New repository
- Name it `wc2026-updater` (private is fine)
- Don't initialise with README

### 2. Upload these files
Upload both files to the repo:
- `update.js`
- `.github/workflows/update-scores.yml`

### 3. Add your secret keys
In your GitHub repo → Settings → Secrets and variables → Actions → New repository secret

Add these two secrets:

| Name | Value |
|------|-------|
| `FOOTBALL_API_KEY` | `dafecc5c160c471092baaaaaffc690b9` |
| `FIREBASE_SECRET` | `xzbgA8ul05Fb2e5C6PlNQgPDprOvksSxdlgBef7x` |

### 4. Enable Actions
- Go to the Actions tab in your repo
- Click "I understand my workflows, go ahead and enable them"
- Click on "WC 2026 Score Updater" → "Run workflow" to test it manually first

### 5. That's it!
The script will now run automatically every 10 minutes during the tournament, pulling all finished match data and updating your Firebase database. Your leaderboard updates in real time for all players.

## How it works
1. Fetches all WC 2026 match results from football-data.org
2. Calculates each team's: wins, draws, goals for, goals against, red cards, rounds reached, semi-final wins, final wins
3. Writes directly to your Firebase Realtime Database
4. Your app reads from Firebase in real time — leaderboard updates instantly

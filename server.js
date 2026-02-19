const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const LICHESS = "https://lichess.org";
const FETCH_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function forEachNdjson(response, onItem) {
  if (!response.body) throw new Error("Réponse NDJSON vide.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) onItem(JSON.parse(line));
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  const trailing = buffer.trim();
  if (trailing) onItem(JSON.parse(trailing));
}

// ===== API ENDPOINT =====
app.post("/api/analyze", async (req, res) => {
  try {
    const { tournamentId, type } = req.body;
    if (!tournamentId || !type) return res.status(400).json({ error: "tournamentId et type requis" });
    if (!/^[a-zA-Z0-9]+$/.test(tournamentId)) return res.status(400).json({ error: "tournamentId invalide" });
    if (type !== "swiss" && type !== "arena") return res.status(400).json({ error: "type invalide" });

    const endpoint = type === "swiss" ? "swiss" : "tournament";

    // 1. Infos tournoi
    const tRes = await fetchWithTimeout(`${LICHESS}/api/${endpoint}/${tournamentId}`, { headers: { Accept: "application/json" } });
    if (!tRes.ok) return res.status(404).json({ error: "Tournoi introuvable." });
    const tournament = await tRes.json();

    // 2. Parties avec analyses
    const gRes = await fetchWithTimeout(`${LICHESS}/api/${endpoint}/${tournamentId}/games?evals=true&accuracy=true&moves=true`, { headers: { Accept: "application/x-ndjson" } });
    if (!gRes.ok) return res.status(500).json({ error: "Impossible de récupérer les parties." });

    // 3. Agréger en stream pour limiter la mémoire
    let gameCount = 0;
    let unanalyzedCount = 0;
    let lichessCount = 0;
    let fullyAnalyzedCount = 0;
    let shortCount = 0;

    const ps = new Map();

    await forEachNdjson(gRes, (g) => {
      gameCount++;
      const whiteAnalysis = g.players?.white?.analysis;
      const blackAnalysis = g.players?.black?.analysis;
      const hasWhiteAnalysis = whiteAnalysis != null;
      const hasBlackAnalysis = blackAnalysis != null;

      if (hasWhiteAnalysis || hasBlackAnalysis) lichessCount++;
      if (hasWhiteAnalysis && hasBlackAnalysis) fullyAnalyzedCount++;

      const moveCount = g.moves ? g.moves.split(" ").length : 0;
      const isShortGame = moveCount < 10 || g.status === "aborted" || g.status === "noStart";
      if (!hasWhiteAnalysis || !hasBlackAnalysis) {
        if (isShortGame) {
          shortCount++;
        } else if (g.moves) {
          unanalyzedCount++;
        }
      }

      for (const c of ["white", "black"]) {
        const name = g.players?.[c]?.user?.name || "Anonymous";
        if (!ps.has(name)) ps.set(name, { username: name, inaccuracies: 0, mistakes: 0, blunders: 0, gamesPlayed: 0, analyzedGames: 0, team: g.players?.[c]?.team, accuracies: [] });

        const s = ps.get(name);
        s.gamesPlayed++;
        if (!s.team && g.players?.[c]?.team) s.team = g.players?.[c]?.team;

        const a = g.players?.[c]?.analysis;
        if (a) {
          s.inaccuracies += Number(a.inaccuracy) || 0;
          s.mistakes += Number(a.mistake) || 0;
          s.blunders += Number(a.blunder) || 0;
          if (a.accuracy != null) s.accuracies.push(Number(a.accuracy) || 0);
          s.analyzedGames++;
        }
      }
    });

    if (!gameCount) return res.status(404).json({ error: "Aucune partie trouvée." });

    // 4. Métriques
    const metrics = Array.from(ps.values()).map(p => ({
      ...p, accuracy: p.accuracies.length > 0 ? Math.round((p.accuracies.reduce((a, b) => a + b, 0) / p.accuracies.length) * 10) / 10 : 0,
    }));

    // 5. Classement (seuil 4 parties + 50%)
    const withAnalysis = metrics.filter(p => p.analyzedGames > 0);
    const eligible = metrics.filter(p => p.analyzedGames >= 4 && (p.analyzedGames / p.gamesPlayed) >= 0.5);
    const pool = eligible.length >= 2 ? eligible : withAnalysis;
    if (!pool.length) return res.status(400).json({ error: "Aucune partie analysée." });

    const sd = (arr, k) => [...arr].sort((a, b) => b[k] - a[k]);
    const sa = (arr, k, k2) => [...arr].sort((a, b) => { const d = a[k] - b[k]; return d !== 0 ? d : (k2 ? b[k2] - a[k2] : 0); });

    res.json({
      tournamentId: tournament.id, tournamentName: tournament.name || tournament.fullName || "Tournoi", playerCount: tournament.nbPlayers, gameCount,
      analyzedByLichess: lichessCount, totalAnalyzed: fullyAnalyzedCount,
      skippedShortGames: shortCount, unanalyzedGames: unanalyzedCount,
      eligiblePlayers: pool.length, totalPlayersWithAnalysis: withAnalysis.length,
      metrics: {
        mostInaccuracies: { player: sd(pool, "inaccuracies")[0].username, count: sd(pool, "inaccuracies")[0].inaccuracies },
        leastInaccuracies: { player: sa(pool, "inaccuracies", "accuracy")[0].username, count: sa(pool, "inaccuracies", "accuracy")[0].inaccuracies },
        mostMistakes: { player: sd(pool, "mistakes")[0].username, count: sd(pool, "mistakes")[0].mistakes },
        leastMistakes: { player: sa(pool, "mistakes", "accuracy")[0].username, count: sa(pool, "mistakes", "accuracy")[0].mistakes },
        mostBlunders: { player: sd(pool, "blunders")[0].username, count: sd(pool, "blunders")[0].blunders },
        leastBlunders: { player: sa(pool, "blunders", "accuracy")[0].username, count: sa(pool, "blunders", "accuracy")[0].blunders },
        highestAccuracy: { player: sd(pool, "accuracy")[0].username, accuracy: sd(pool, "accuracy")[0].accuracy },
        lowestAccuracy: { player: sa(pool, "accuracy")[0].username, accuracy: sa(pool, "accuracy")[0].accuracy },
      },
      playerMetrics: metrics,
    });
  } catch (e) {
    console.error(e);
    if (e.name === "AbortError") return res.status(504).json({ error: "Lichess ne répond pas à temps." });
    res.status(500).json({ error: e.message || "Erreur serveur" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));

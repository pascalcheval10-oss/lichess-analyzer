const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== API ENDPOINT =====
app.post("/api/analyze", async (req, res) => {
  try {
    const { tournamentId, type } = req.body;
    if (!tournamentId || !type) return res.status(400).json({ error: "tournamentId et type requis" });
    const LICHESS = "https://lichess.org";
    const endpoint = type === "swiss" ? "swiss" : "tournament";
    const depth = 15;

    // 1. Infos tournoi
    const tRes = await fetch(`${LICHESS}/api/${endpoint}/${tournamentId}`, { headers: { Accept: "application/json" } });
    if (!tRes.ok) return res.status(404).json({ error: "Tournoi introuvable." });
    const tournament = await tRes.json();

    // 2. Parties avec analyses
    const gRes = await fetch(`${LICHESS}/api/${endpoint}/${tournamentId}/games?evals=true&accuracy=true&moves=true`, { headers: { Accept: "application/x-ndjson" } });
    if (!gRes.ok) return res.status(500).json({ error: "Impossible de récupérer les parties." });
    const games = (await gRes.text()).trim().split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
    if (!games.length) return res.status(404).json({ error: "Aucune partie trouvée." });

    // 3. Compter les parties non analysées
    let unanalyzedCount = 0;
    for (const g of games) {
      const hW = g.players?.white?.analysis != null, hB = g.players?.black?.analysis != null;
      if (!hW || !hB) {
        const mc = g.moves ? g.moves.split(" ").length : 0;
        if (g.moves && mc >= 10 && g.status !== "aborted" && g.status !== "noStart") {
          unanalyzedCount++;
        }
      }
    }

    // 4. Agréger
    const ps = new Map();
    for (const g of games) {
      for (const c of ["white", "black"]) {
        const name = g.players?.[c]?.user?.name || "Anonymous";
        if (!ps.has(name)) ps.set(name, { username: name, inaccuracies: 0, mistakes: 0, blunders: 0, gamesPlayed: 0, analyzedGames: 0, team: g.players?.[c]?.team, accuracies: [] });
        const s = ps.get(name); s.gamesPlayed++;
        const a = g.players?.[c]?.analysis;
        if (a) { s.inaccuracies += a.inaccuracy; s.mistakes += a.mistake; s.blunders += a.blunder; if (a.accuracy != null) s.accuracies.push(a.accuracy); s.analyzedGames++; }
      }
    }

    // 6. Métriques
    const metrics = Array.from(ps.values()).map(p => ({
      ...p, accuracy: p.accuracies.length > 0 ? Math.round((p.accuracies.reduce((a, b) => a + b, 0) / p.accuracies.length) * 10) / 10 : 0,
    }));

    // 7. Classement (seuil 4 parties + 50%)
    const withAnalysis = metrics.filter(p => p.analyzedGames > 0);
    const eligible = metrics.filter(p => p.analyzedGames >= 4 && (p.analyzedGames / p.gamesPlayed) >= 0.5);
    const pool = eligible.length >= 2 ? eligible : withAnalysis;
    if (!pool.length) return res.status(400).json({ error: "Aucune partie analysée." });

    const sd = (arr, k) => [...arr].sort((a, b) => b[k] - a[k]);
    const sa = (arr, k, k2) => [...arr].sort((a, b) => { const d = a[k] - b[k]; return d !== 0 ? d : (k2 ? b[k2] - a[k2] : 0); });

    const lichessCount = games.filter(g => g.players?.white?.analysis != null || g.players?.black?.analysis != null).length;
    const shortCount = games.filter(g => { if (g.players?.white?.analysis && g.players?.black?.analysis) return false; const mc = g.moves ? g.moves.split(" ").length : 0; return mc < 10 || g.status === "aborted" || g.status === "noStart"; }).length;

    res.json({
      tournamentId: tournament.id, tournamentName: tournament.name || tournament.fullName || "Tournoi", playerCount: tournament.nbPlayers, gameCount: games.length,
      analyzedByLichess: lichessCount, totalAnalyzed: lichessCount,
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
  } catch (e) { console.error(e); res.status(500).json({ error: e.message || "Erreur serveur" }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));

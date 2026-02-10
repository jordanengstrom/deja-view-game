import express from "express";
import { InitResponse } from "../shared/types/api";
import {
  createServer,
  context,
  getServerPort,
  reddit,
  redis
} from "@devvit/web/server";
import { createPost } from "./core/post";

const app = express();

// Middleware for JSON body parsing
app.use(express.json());
// Middleware for URL-encoded body parsing
app.use(express.urlencoded({ extended: true }));
// Middleware for plain text body parsing
app.use(express.text());

const router = express.Router();

router.get<
  { postId: string },
  InitResponse | { status: string; message: string }
>("/api/init", async (_req, res): Promise<void> => {
  const { postId } = context;

  if (!postId) {
    console.error("API Init Error: postId not found in devvit context");
    res.status(400).json({
      status: "error",
      message: "postId is required but missing from context",
    });
    return;
  }

  try {
    const username = await reddit.getCurrentUsername();

    res.json({
      type: "init",
      postId: postId,
      username: username ?? "anonymous",
    });
  } catch (error) {
    console.error(`API Init Error for post ${postId}:`, error);
    let errorMessage = "Unknown error during initialization";
    if (error instanceof Error) {
      errorMessage = `Initialization failed: ${error.message}`;
    }
    res.status(400).json({ status: "error", message: errorMessage });
  }
});

// Add your game-specific API endpoints here
// Examples:
// router.post("/api/save-score", async (req, res) => { ... });
// router.get("/api/leaderboard", async (req, res) => { ... });
// router.post("/api/game-event", async (req, res) => { ... });

// ##########################################################################
// # DEMO SAMPLE: State + Score + Leaderboard using Redis
// ##########################################################################

type StoredState = {
  username: string;
  bestScore?: number;              // <- optional; we mirror leaderboard here
  data?: Record<string, unknown>;
  updatedAt: number;
};

function getUtcDayInteger(offsetDays: number = 0, date: Date = new Date()): string {
  if (offsetDays > 0) {
    date.setUTCDate(date.getUTCDate() + offsetDays);
  }

  const yyyy = date.getUTCFullYear();
  const mm = date.getUTCMonth() + 1; // Months are 0-indexed in JS
  const dd = date.getUTCDate();
  const outDate = yyyy * 10000 + mm * 100 + dd;
  return outDate.toString();
}

function stateKey(postId: string, username: string) {
  return `state:${postId}:${username}`;
}

function leaderboardKey(postId: string) {
    return `lb:${postId}`;
}

function dailyLeaderboardKey(postId: string, date: string) {
  return `lb:${postId}:${date}`;
}

async function getUsername(): Promise<string> {
  const u = await reddit.getCurrentUsername();
  return u ?? "anonymous";
}

// GET /api/state -> fetch current user's state for this post
router.get("/api/state", async (_req, res) => {
  try {
    const { postId } = context;
    if (!postId) return res.status(400).json({ error: "Missing postId in context" });

    const username = await getUsername();
    const key = stateKey(postId, username);
    const json = await redis.get(key);
    if (!json) return res.status(404).json({ error: "No state found" });

    let stateData = JSON.parse(json) as StoredState;
    console.log("GET /api/state stateData:", JSON.stringify(stateData));

    res.json(JSON.parse(json) as StoredState);
  
  } catch (err) {
    console.error("GET /api/state error:", err);
    res.status(500).json({ error: "Failed to fetch state" });
  }
});

// POST /api/state -> upsert current user's state for this post
router.post("/api/state", async (req, res) => {
  try {
    const { postId } = context;
    if (!postId) return res.status(400).json({ error: "Missing postId in context" });

    const username = await getUsername();
    if (username === "anonymous") return res.status(401).json({ error: "Login required" });

    const { data } = req.body ?? {};
    if (data !== undefined && (typeof data !== "object" || data === null)) {
      return res.status(400).json({ error: "data must be an object" });
    }

    const key = stateKey(postId, username);
    const prevRaw = await redis.get(key);
    const prev = (prevRaw ? JSON.parse(prevRaw) : {}) as Partial<StoredState>;

    // build the new state; only include optional fields if they exist
    const next: StoredState = {
      username,
      updatedAt: Date.now(),
      ...(data !== undefined ? { data } : (prev.data !== undefined ? { data: prev.data } : {})),
      ...(prev.bestScore !== undefined ? { bestScore: prev.bestScore } : {}),
    };

    await redis.set(key, JSON.stringify(next));

    console.log("POST /api/state next:", JSON.stringify(next));

    res.json(next);
  } catch (err) {
    console.error("POST /api/state error:", err);
    res.status(500).json({ error: "Failed to save state" });
  }
});

// POST /api/score -> submit/update best score for this post
router.post("/api/score", async (req, res) => {
  try {
    const { postId } = context;
    if (!postId) return res.status(400).json({ error: "Missing postId" });

    const username = await getUsername();
    if (username === "anonymous") return res.status(401).json({ error: "Login required" });

    // Use our new simplified structure
    const { score } = req.body ?? {};
    
    if (typeof score !== "number" || !Number.isFinite(score)) {
      return res.status(400).json({ error: "Invalid score" });
    }

    const sanitized = Math.max(0, Math.min(score, 1_000_000_000));
    const lbKey = leaderboardKey(postId);
    const dateBucket = getUtcDayInteger();
    const dailyKey = dailyLeaderboardKey(postId, dateBucket);

    // 1. Get old scores to compare (Global and Daily)
    const [existingGlobal, existingDaily] = await Promise.all([
      redis.zScore(lbKey, username),
      redis.zScore(dailyKey, username)
    ]);
    
    const globalScore = existingGlobal !== undefined && existingGlobal !== null ? Number(existingGlobal) : -1;
    const dailyScore = existingDaily !== undefined && existingDaily !== null ? Number(existingDaily) : -1;
    
    // 2. Determine best scores
    const bestGlobal = Math.max(globalScore, sanitized);
    const bestDaily = Math.max(dailyScore, sanitized);
    
    const isNewBestGlobal = sanitized > globalScore;

    // 3. Update Leaderboards
    await Promise.all([
      redis.zAdd(lbKey, { score: bestGlobal, member: username }),
      redis.zAdd(dailyKey, { score: bestDaily, member: username })
    ]);

    // 4. Update User State (optional, keeps your persistence logic)
    const sKey = stateKey(postId, username);
    const prevRaw = await redis.get(sKey);
    const prev = (prevRaw ? JSON.parse(prevRaw) : {}) as StoredState;

    const next: StoredState = {
      username,
      updatedAt: Date.now(),
      bestScore: bestGlobal,
      data: {
        ...(prev.data || {}),
        date: dateBucket,
      },
    };
    await redis.set(sKey, JSON.stringify(next));

    // 5. Calculate Rank immediately
    // If we're tracking daily stuff, which rank do we return? 
    // Usually the one relevant to the "Best" notification, which is Global often.
    // But let's return Daily Rank if the user is focused on Daily?
    // The previous code returned one rank. Let's return Global Rank to be consistent with "rank" 
    // and maybe "dailyRank" if needed, but let's stick to Global for the primary response unless asked.
    
    const ascRank = await redis.zRank(lbKey, username);
    const totalPlayers = await redis.zCard(lbKey);
    
    let rank = 0;
    if (ascRank !== undefined && ascRank !== null) {
      // Invert the rank
      rank = totalPlayers - Number(ascRank);
    }
    const scoreData = { 
      success: true,
      score: bestGlobal, 
      rank, 
      totalPlayers,
      isNewBest: isNewBestGlobal,
      updatedAt: next.updatedAt,
      dateBucket: dateBucket,
    };
    console.log("POST /api/score scoreData:", JSON.stringify(scoreData));
    // 6. Return everything GameMaker needs in one go
    res.json(scoreData);

  } catch (err) {
    console.error("POST /api/score error:", err);
    res.status(500).json({ error: "Failed to submit score" });
  }
});

// GET /api/leaderboard?limit=10&date=YYYYMMDD -> top N + caller's rank
router.get("/api/leaderboard", async (req, res) => {
  try {
    const { postId } = context;
    if (!postId) {
      return res.status(400).json({ error: "Missing postId in context" });
    }

    const username = await getUsername();
    const limitParam = Number(req.query.limit ?? 10);
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 100)) : 10;

    const dateParam = req.query.date as string | undefined;
    
    // Logic: If date param is provided, query daily leaderboard.
    // If NO date param is provided, user asked to default to "Today".
    // Therefore, we ALWAYS default to a daily view unless explicitly "all" (not implemented yet).
    const effectiveDate = dateParam ?? getUtcDayInteger();
    const lbKey = dailyLeaderboardKey(postId, effectiveDate);

    // Fetch top entries from the specific daily zset
    const entries = await redis.zRange(lbKey, 0, limit - 1);

    // Hydrate with date from State (fetched via separate key)
    const enrichedPromises = entries.map(async (e, i) => {
      const u = e.member;
      // Note: State might store the "Global Best" date, not necessarily "This Daily Score" date.
      // But for a daily leaderboard, the date is implicit (effectiveDate).
      // We can fetch state if we want other metadata, or just return what we have.
      return {
        rank: i + 1,
        username: u,
        score: Number(e.score ?? 0),
        date: effectiveDate,
      };
    });

    const top = await Promise.all(enrichedPromises);

    // find caller's rank in this specific daily leaderboard
    const ascRank = await redis.zRank(lbKey, username);
    const total = Number((await redis.zCard(lbKey)) ?? 0);
    const meRank0 =
      ascRank !== null && ascRank !== undefined && total
        ? total - 1 - Number(ascRank) // flip ascending to descending
        : ascRank;

    let me = null;
    if (meRank0 !== undefined && meRank0 !== null) {
      me = {
        rank: Number(meRank0) + 1,
        username,
        score: Number((await redis.zScore(lbKey, username)) ?? 0),
        date: effectiveDate,
      };
    }

    const dataOut = {
      top,
      me,
      totalPlayers: total,
      generatedAt: Date.now(),
      filterDate: effectiveDate
    };
    console.log("GET /api/leaderboard dataOut:", JSON.stringify(dataOut));

    res.json(dataOut);
  } catch (err) {
    console.error("GET /api/leaderboard error:", err);
    res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
});

// ##########################################################################

router.post("/internal/on-app-install", async (_req, res): Promise<void> => {
  try {
    const post = await createPost();

    res.json({
      status: "success",
      message: `Post created in subreddit ${context.subredditName} with id ${post.id}`,
    });
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    res.status(400).json({
      status: "error",
      message: "Failed to create post",
    });
  }
});

router.post("/internal/menu/post-create", async (_req, res): Promise<void> => {
  try {
    const post = await createPost();

    res.json({
      navigateTo: `https://reddit.com/r/${context.subredditName}/comments/${post.id}`,
    });
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    res.status(400).json({
      status: "error",
      message: "Failed to create post",
    });
  }
});

app.use(router);

const server = createServer(app);
server.on("error", (err) => console.error(`server error; ${err.stack}`));
server.listen(getServerPort());

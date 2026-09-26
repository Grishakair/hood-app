import { WebSocketServer } from "ws";
import { recoverMessageAddress } from "viem";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Prototype matchmaking server: virtual money only, in-memory duel state,
// user profiles (rating/history/achievements/referrals) persisted to a flat
// JSON file so they survive a server restart during dev. No real funds ever
// move here.
//
// Supports three match types:
//   - "test"  : practice, always 1v1, fixed virtual stake, never touches
//               balance/rating/history.
//   - "pvp"   : real (virtual-dollar) stake, auto-matched via a public queue.
//   - "lobby" : real stake, private — a host creates it (optionally
//               password-protected) and shares a link; joined by id.
// Both "pvp" and "lobby" support size 2 (1v1) or 5 ("Battleground" —
// winner takes the whole pot). Token picks happen AFTER the match is
// found (a 20s pick window), not before — this is what makes queueing
// fast regardless of basket choice.

const __dirname = dirname(fileURLToPath(import.meta.url));
// Overridable so a local test run never clobbers real profile data.
const DATA_FILE = process.env.DUEL_DATA_FILE || join(__dirname, "data.json");
const PORT = Number(process.env.DUEL_SERVER_PORT) || 8787;
const DEFAULT_BALANCE = 1000;
const ROUND_SECONDS = 30;
const PICK_SECONDS = 20;
const TICK_MS = 1000;
const PICK_CHECK_MS = 500;
const PRICE_REFRESH_MS = 3000;
const MAX_PICKS = 4;
const ELO_K = 32;
const REFERRAL_SIGNUP_BONUS = 50; // credited to the new player
const REFERRAL_INVITER_BONUS = 25; // credited to whoever invited them
const HISTORY_LIMIT = 20;
const REFERRAL_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
const STAKES = [10, 25, 50, 75];
const SIZES = [2, 5];
const PRACTICE_ENTRY_AMOUNT = 25;

// The 20 pairs shown in the token-pick grid. Prices come from Binance spot
// tickers (public REST API, no key needed) — this is a read-only price
// oracle for the game, not an on-chain oracle; see docs/custody-plan.md for
// what an on-chain price feed would need once real funds are involved.
const ASSET_BINANCE = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  BNB: "BNBUSDT",
  XRP: "XRPUSDT",
  ADA: "ADAUSDT",
  DOGE: "DOGEUSDT",
  AVAX: "AVAXUSDT",
  LINK: "LINKUSDT",
  DOT: "DOTUSDT",
  MATIC: "MATICUSDT",
  LTC: "LTCUSDT",
  TRX: "TRXUSDT",
  ATOM: "ATOMUSDT",
  NEAR: "NEARUSDT",
  ZEC: "ZECUSDT",
  AAVE: "AAVEUSDT",
  ARB: "ARBUSDT",
  OP: "OPUSDT",
  UNI: "UNIUSDT",
};

// Same ids the frontend's ACHIEVEMENT_DEFS map uses for title/description/icon.
const ACHIEVEMENT_DEFS = [
  { id: "first_win", check: (u) => u.wins >= 1 },
  { id: "win_streak_3", check: (u) => u.streak >= 3 },
  { id: "win_streak_5", check: (u) => u.streak >= 5 },
  { id: "veteran_10", check: (u) => u.wins + u.losses + u.ties >= 10 },
  { id: "centurion_100", check: (u) => u.wins + u.losses + u.ties >= 100 },
  { id: "high_roller", check: (u, ctx) => ctx?.won && ctx?.entryAmount >= 75 },
  { id: "full_basket", check: (u, ctx) => ctx?.won && ctx?.picks?.length >= 4 },
  { id: "whale_200", check: (u) => u.balance - DEFAULT_BALANCE >= 200 },
  { id: "first_referral", check: (u) => u.referrals.length >= 1 },
  { id: "battleground_win", check: (u, ctx) => ctx?.won && ctx?.size >= 5 },
];

function loadData() {
  if (existsSync(DATA_FILE)) {
    try {
      return JSON.parse(readFileSync(DATA_FILE, "utf8"));
    } catch {
      // corrupt file — start fresh rather than crash the server
    }
  }
  return { users: {} };
}

const data = loadData();
function saveData() {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const codeToAddress = new Map();
for (const [addr, u] of Object.entries(data.users)) {
  if (u.referralCode) codeToAddress.set(u.referralCode, addr);
}

function genReferralCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => REFERRAL_CODE_CHARS[Math.floor(Math.random() * REFERRAL_CODE_CHARS.length)]).join("");
  } while (codeToAddress.has(code));
  return code;
}

function getUser(address) {
  const key = address.toLowerCase();
  if (!data.users[key]) {
    const referralCode = genReferralCode();
    data.users[key] = {
      nickname: null,
      balance: DEFAULT_BALANCE,
      rating: 1000,
      wins: 0,
      losses: 0,
      ties: 0,
      streak: 0,
      bestStreak: 0,
      achievements: [],
      referralCode,
      referredBy: null,
      referrals: [],
      history: [],
    };
    codeToAddress.set(referralCode, key);
    saveData();
  }
  return data.users[key];
}

function tierFor(rating) {
  if (rating >= 1600) return "Diamond";
  if (rating >= 1400) return "Platinum";
  if (rating >= 1200) return "Gold";
  if (rating >= 1000) return "Silver";
  return "Bronze";
}

function updateElo(ratingSelf, ratingOpp, score) {
  const expected = 1 / (1 + Math.pow(10, (ratingOpp - ratingSelf) / 400));
  return ratingSelf + ELO_K * (score - expected);
}

function checkAchievements(user, ctx) {
  const unlocked = [];
  for (const def of ACHIEVEMENT_DEFS) {
    if (!user.achievements.includes(def.id) && def.check(user, ctx)) {
      user.achievements.push(def.id);
      unlocked.push(def.id);
    }
  }
  return unlocked;
}

function publicProfile(address) {
  const key = address.toLowerCase();
  const u = getUser(key);
  return {
    address: key,
    nickname: u.nickname,
    balance: u.balance,
    rating: Math.round(u.rating),
    tier: tierFor(u.rating),
    wins: u.wins,
    losses: u.losses,
    ties: u.ties,
    streak: u.streak,
    bestStreak: u.bestStreak,
    achievements: u.achievements,
    referralCode: u.referralCode,
    referredBy: u.referredBy,
    referralCount: u.referrals.length,
    history: [...u.history].reverse(),
  };
}

// ---- socket bookkeeping: one address can have several open tabs ----
const socketsByAddress = new Map(); // lowercased address -> Set<ws>
const addressBySocket = new Map(); // ws -> lowercased address

function subscribe(ws, address) {
  const key = address.toLowerCase();
  addressBySocket.set(ws, key);
  if (!socketsByAddress.has(key)) socketsByAddress.set(key, new Set());
  socketsByAddress.get(key).add(ws);
}

function unsubscribe(ws) {
  const key = addressBySocket.get(ws);
  if (!key) return null;
  addressBySocket.delete(ws);
  const set = socketsByAddress.get(key);
  if (set) {
    set.delete(ws);
    if (set.size === 0) socketsByAddress.delete(key);
  }
  return key;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sendToAddress(address, msg) {
  const set = socketsByAddress.get(address.toLowerCase());
  if (!set) return;
  for (const ws of set) send(ws, msg);
}

function broadcastToLobby(lobby, msg) {
  for (const p of lobby.players) sendToAddress(p.address, msg);
}

function broadcastAll(msg) {
  for (const ws of wss.clients) send(ws, msg);
}

// ---- lobbies (queue buckets, private lobbies, and active/done duels) ----
// { id, kind:'queue'|'lobby', matchType:'test'|'pvp'|'lobby', size, entryAmount,
//   practice, password, players:[{address,nickname,picks,ready}],
//   status:'queueing'|'picking'|'active'|'done', pickDeadline, symbols,
//   entryPrices:{addr:{sym:price}}, startedAt, history, roundSeconds }
const lobbies = new Map();

function lobbyPlayerPublic(p) {
  const u = getUser(p.address);
  return {
    address: p.address,
    nickname: p.nickname,
    picks: p.picks,
    ready: p.ready,
    rating: Math.round(u.rating),
    tier: tierFor(u.rating),
  };
}

function queueSummary(lobby) {
  return {
    id: lobby.id,
    kind: lobby.kind,
    matchType: lobby.matchType,
    size: lobby.size,
    entryAmount: lobby.entryAmount,
    practice: lobby.practice,
    hasPassword: !!lobby.password,
    players: lobby.players.map(lobbyPlayerPublic),
  };
}

function publicLobbyList() {
  // Only surface open, password-less private lobbies (join-by-link is the
  // primary flow; this list is a convenience, same as the old 1v1 browser).
  return [...lobbies.values()]
    .filter((l) => l.kind === "lobby" && l.status === "queueing" && !l.password)
    .map((l) => ({
      id: l.id,
      size: l.size,
      entryAmount: l.entryAmount,
      hostNickname: l.players[0]?.nickname,
      hostRating: lobbyPlayerPublic(l.players[0])?.rating,
      hostTier: lobbyPlayerPublic(l.players[0])?.tier,
      slotsFilled: l.players.length,
    }));
}

function broadcastLobbies() {
  broadcastAll({ type: "lobbies", lobbies: publicLobbyList() });
}

function hasActiveEngagement(address) {
  const key = address.toLowerCase();
  for (const l of lobbies.values()) {
    if (l.status === "done") continue;
    if (l.players.some((p) => p.address.toLowerCase() === key)) return true;
  }
  return false;
}

function findLobbyForAddress(address, statuses) {
  const key = address.toLowerCase();
  for (const l of lobbies.values()) {
    if (statuses && !statuses.includes(l.status)) continue;
    if (l.players.some((p) => p.address.toLowerCase() === key)) return l;
  }
  return null;
}

// ---- Binance price cache shared across all active duels ----
const priceCache = new Map();
// Recent 20-pair % moves, kept fresh for the pick screen even before any
// duel is running (so the token grid can show live daily change).
const dayChangeCache = new Map();

async function refreshPrices() {
  const symbols = new Set(Object.values(ASSET_BINANCE));
  for (const l of lobbies.values()) {
    if (l.status === "active") l.symbols.forEach((s) => symbols.add(s));
  }
  if (symbols.size === 0) return;
  try {
    const query = encodeURIComponent(JSON.stringify([...symbols]));
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${query}`);
    if (res.ok) {
      const rows = await res.json();
      for (const row of rows) priceCache.set(row.symbol, parseFloat(row.price));
    }
  } catch {
    // transient hiccup — keep the stale cache, next refresh retries
  }
}

async function refreshDayChange() {
  try {
    const query = encodeURIComponent(JSON.stringify(Object.values(ASSET_BINANCE)));
    const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${query}&type=MINI`);
    if (res.ok) {
      const rows = await res.json();
      for (const row of rows) {
        const pct = parseFloat(row.priceChangePercent ?? row.priceChange);
        if (!Number.isNaN(pct)) dayChangeCache.set(row.symbol, pct);
      }
    }
  } catch {
    // best-effort only — the pick grid just shows "—" until this succeeds
  }
}
setInterval(refreshPrices, PRICE_REFRESH_MS);
setInterval(refreshDayChange, 15000);
refreshPrices();
refreshDayChange();

async function fetchPricesNow(symbols) {
  const query = encodeURIComponent(JSON.stringify(symbols));
  const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${query}`);
  if (!res.ok) throw new Error(`binance ${res.status}`);
  const rows = await res.json();
  const bySymbol = {};
  for (const row of rows) {
    bySymbol[row.symbol] = parseFloat(row.price);
    priceCache.set(row.symbol, parseFloat(row.price));
  }
  return bySymbol;
}

// Equal-weight basket: each picked asset is 1/N of the entry amount.
function portfolioPct(picks, entryPricesBySymbol, livePricesByBinanceSymbol) {
  const changes = picks.map((sym) => {
    const entry = entryPricesBySymbol[sym];
    const live = livePricesByBinanceSymbol[ASSET_BINANCE[sym]];
    if (!entry || !live) return null;
    return ((live - entry) / entry) * 100;
  });
  if (changes.length === 0 || changes.some((c) => c == null)) return null;
  return changes.reduce((s, c) => s + c, 0) / changes.length;
}

function duelStartedPayload(lobby) {
  return {
    type: "duel_started",
    lobbyId: lobby.id,
    entryAmount: lobby.entryAmount,
    practice: lobby.practice,
    roundSeconds: lobby.roundSeconds,
    players: lobby.players.map(lobbyPlayerPublic),
  };
}

async function startDuel(lobby) {
  // status flips to "active" only once entryPrices/startedAt/history are all
  // set — the global tick loop below starts ticking any "active" lobby every
  // second, and fetchPricesNow() is an awaited network call, so flipping the
  // status any earlier left a window where a tick could fire against a
  // lobby with no entryPrices yet and crash the whole process.
  lobby.symbols = [...new Set(lobby.players.flatMap((p) => p.picks).map((s) => ASSET_BINANCE[s]))];
  const prices = await fetchPricesNow(lobby.symbols);
  lobby.entryPrices = {};
  for (const p of lobby.players) {
    lobby.entryPrices[p.address.toLowerCase()] = Object.fromEntries(
      p.picks.map((s) => [s, prices[ASSET_BINANCE[s]]])
    );
  }
  lobby.startedAt = Date.now();
  lobby.roundSeconds = ROUND_SECONDS;
  lobby.history = [];
  lobby.status = "active";
  broadcastLobbies();
  broadcastToLobby(lobby, duelStartedPayload(lobby));
}

function tickDuel(lobby) {
  if (!lobby.entryPrices) return; // still mid-startDuel — skip this tick, don't crash
  const elapsed = (Date.now() - lobby.startedAt) / 1000;
  const timeLeft = Math.max(lobby.roundSeconds - elapsed, 0);

  const pctByAddress = {};
  for (const p of lobby.players) {
    const key = p.address.toLowerCase();
    const live = Object.fromEntries(p.picks.map((s) => [ASSET_BINANCE[s], priceCache.get(ASSET_BINANCE[s])]));
    pctByAddress[key] = portfolioPct(p.picks, lobby.entryPrices[key], live);
  }
  lobby.history.push({ t: Math.round((lobby.roundSeconds - timeLeft) * 10) / 10, pct: pctByAddress });

  broadcastToLobby(lobby, {
    type: "tick",
    lobbyId: lobby.id,
    timeLeft,
    pct: pctByAddress,
    history: lobby.history,
  });

  if (timeLeft <= 0) finishDuel(lobby, pctByAddress);
}

function finishDuel(lobby, finalPctByAddress) {
  lobby.status = "done";
  const size = lobby.players.length;
  const ranked = [...lobby.players]
    .map((p) => ({ p, pct: finalPctByAddress[p.address.toLowerCase()] ?? 0 }))
    .sort((a, b) => b.pct - a.pct);
  const topPct = ranked[0].pct;
  const winners = ranked.filter((r) => r.pct === topPct);
  const winnerAddresses = new Set(winners.map((r) => r.p.address.toLowerCase()));

  const pot = lobby.entryAmount * size;
  const netByAddress = {};
  for (const r of ranked) {
    const key = r.p.address.toLowerCase();
    netByAddress[key] = winnerAddresses.has(key)
      ? pot / winners.length - lobby.entryAmount
      : -lobby.entryAmount;
  }

  const newAchievementsByAddress = {};
  if (!lobby.practice) {
    // Pairwise ELO: every player plays a virtual 1-on-1 against every other
    // player in the match, scored by final placement; ratings update off the
    // average of those pairwise expected scores. For a 1v1 this reduces to
    // exactly the old head-to-head formula.
    const oldRatings = new Map(lobby.players.map((p) => [p.address.toLowerCase(), getUser(p.address).rating]));
    const deltas = new Map(lobby.players.map((p) => [p.address.toLowerCase(), 0]));
    for (const a of lobby.players) {
      const keyA = a.address.toLowerCase();
      for (const b of lobby.players) {
        const keyB = b.address.toLowerCase();
        if (keyA === keyB) continue;
        const pctA = finalPctByAddress[keyA] ?? 0;
        const pctB = finalPctByAddress[keyB] ?? 0;
        const score = pctA > pctB ? 1 : pctA < pctB ? 0 : 0.5;
        const expected = updateElo(oldRatings.get(keyA), oldRatings.get(keyB), score) - oldRatings.get(keyA);
        deltas.set(keyA, deltas.get(keyA) + expected / (size - 1));
      }
    }

    const now = Date.now();
    for (const r of ranked) {
      const key = r.p.address.toLowerCase();
      const user = getUser(key);
      const won = winnerAddresses.has(key);
      user.balance += netByAddress[key];
      user.rating = oldRatings.get(key) + deltas.get(key);
      if (won) {
        user.wins += 1;
        user.streak = (user.streak || 0) + 1;
      } else {
        user.losses += 1;
        user.streak = 0;
      }
      user.bestStreak = Math.max(user.bestStreak || 0, user.streak);

      const opponents = lobby.players.filter((p) => p.address.toLowerCase() !== key);
      user.history.push({
        opponent: opponents[0]?.address,
        opponentNickname: opponents.map((o) => o.nickname).join(", "),
        entryAmount: lobby.entryAmount,
        size,
        picks: r.p.picks,
        pct: r.pct,
        result: won ? "win" : "loss",
        ratingDelta: Math.round(deltas.get(key)),
        timestamp: now,
      });
      user.history = user.history.slice(-HISTORY_LIMIT);

      newAchievementsByAddress[key] = checkAchievements(user, {
        won,
        entryAmount: lobby.entryAmount,
        picks: r.p.picks,
        size,
      });
    }
    saveData();
  }

  const resultMsg = {
    type: "duel_result",
    lobbyId: lobby.id,
    entryAmount: lobby.entryAmount,
    practice: lobby.practice,
    ranking: ranked.map((r) => ({
      address: r.p.address,
      nickname: r.p.nickname,
      picks: r.p.picks,
      pct: r.pct,
      won: winnerAddresses.has(r.p.address.toLowerCase()),
      net: Math.round(netByAddress[r.p.address.toLowerCase()] * 100) / 100,
    })),
  };
  for (const p of lobby.players) {
    const key = p.address.toLowerCase();
    sendToAddress(p.address, {
      ...resultMsg,
      profile: lobby.practice ? undefined : publicProfile(key),
      newAchievements: newAchievementsByAddress[key] || [],
    });
  }
  lobbies.delete(lobby.id);
}

function beginPickPhase(lobby) {
  lobby.status = "picking";
  lobby.pickDeadline = Date.now() + PICK_SECONDS * 1000;
  for (const p of lobby.players) p.ready = false;
  broadcastLobbies();
  broadcastToLobby(lobby, {
    type: "match_found",
    lobbyId: lobby.id,
    entryAmount: lobby.entryAmount,
    practice: lobby.practice,
    size: lobby.size,
    pickSeconds: PICK_SECONDS,
    players: lobby.players.map(lobbyPlayerPublic),
  });
}

function maybeStartQueuedMatch(lobby) {
  if (lobby.status === "queueing" && lobby.players.length >= lobby.size) {
    beginPickPhase(lobby);
  } else {
    broadcastLobbies();
    broadcastToLobby(lobby, { type: "queue_update", lobbyId: lobby.id, ...queueSummary(lobby) });
  }
}

// Auto-assign a pick for anyone who doesn't ready up before the pick timer
// runs out, so one AFK player can't strand the rest of the match.
function autoFillPicks(lobby) {
  for (const p of lobby.players) {
    if (!p.ready || p.picks.length === 0) {
      p.picks = ["BTC"];
      p.ready = true;
    }
  }
}

setInterval(() => {
  for (const lobby of lobbies.values()) {
    if (lobby.status !== "picking") continue;
    const allReady = lobby.players.every((p) => p.ready && p.picks.length > 0);
    if (allReady || Date.now() >= lobby.pickDeadline) {
      if (!allReady) autoFillPicks(lobby);
      startDuel(lobby).catch(() => {
        broadcastToLobby(lobby, { type: "error", message: "price_fetch_failed" });
        lobbies.delete(lobby.id);
        broadcastLobbies();
      });
    }
  }
}, PICK_CHECK_MS);

setInterval(() => {
  for (const lobby of lobbies.values()) {
    if (lobby.status !== "active") continue;
    try {
      tickDuel(lobby);
    } catch (err) {
      // One buggy lobby must never take down every other in-progress duel.
      console.error("tickDuel crashed for lobby", lobby.id, err);
    }
  }
}, TICK_MS);

// Last line of defense: a bug anywhere must not kill every active duel on
// the server. Log it and keep running instead of crashing the process.
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));

// ---- websocket wiring ----
const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "hello") {
      if (!msg.address) return;
      subscribe(ws, msg.address);
      send(ws, {
        type: "hello_ack",
        ...publicProfile(msg.address),
        assets: Object.keys(ASSET_BINANCE),
        stakes: STAKES,
        sizes: SIZES,
      });
      send(ws, { type: "lobbies", lobbies: publicLobbyList() });
      send(ws, { type: "day_change", values: Object.fromEntries(dayChangeCache) });

      // resume an in-progress match (queueing, picking, or active) for a
      // reconnecting player instead of stranding them on the connect screen
      const existing = findLobbyForAddress(msg.address, ["queueing", "picking", "active"]);
      if (existing) {
        if (existing.status === "queueing") {
          send(ws, { type: "queue_update", lobbyId: existing.id, ...queueSummary(existing) });
        } else if (existing.status === "picking") {
          send(ws, {
            type: "match_found",
            lobbyId: existing.id,
            entryAmount: existing.entryAmount,
            practice: existing.practice,
            size: existing.size,
            pickSeconds: Math.max(0, (existing.pickDeadline - Date.now()) / 1000),
            players: existing.players.map(lobbyPlayerPublic),
          });
        } else if (existing.status === "active") {
          send(ws, duelStartedPayload(existing));
          const last = existing.history.at(-1);
          send(ws, {
            type: "tick",
            lobbyId: existing.id,
            timeLeft: Math.max(existing.roundSeconds - (Date.now() - existing.startedAt) / 1000, 0),
            pct: last?.pct || {},
            history: existing.history,
          });
        }
      }
      return;
    }

    const address = addressBySocket.get(ws);
    if (!address) {
      send(ws, { type: "error", message: "not_registered" });
      return;
    }

    if (msg.type === "set_nickname") {
      recoverMessageAddress({ message: msg.message, signature: msg.signature })
        .then((recovered) => {
          if (recovered.toLowerCase() !== address) {
            send(ws, { type: "error", message: "bad_signature" });
            return;
          }
          const user = getUser(address);
          user.nickname = String(msg.nickname).slice(0, 20);
          saveData();
          send(ws, { type: "hello_ack", ...publicProfile(address) });
        })
        .catch(() => send(ws, { type: "error", message: "signature_failed" }));
      return;
    }

    if (msg.type === "apply_referral") {
      const user = getUser(address);
      if (user.referredBy) {
        send(ws, { type: "error", message: "referral_already_set" });
        return;
      }
      const code = String(msg.code || "").toUpperCase().trim();
      const refAddress = codeToAddress.get(code);
      if (!refAddress || refAddress === address) {
        send(ws, { type: "error", message: "invalid_referral_code" });
        return;
      }
      const refUser = getUser(refAddress);
      user.referredBy = refAddress;
      user.balance += REFERRAL_SIGNUP_BONUS;
      refUser.balance += REFERRAL_INVITER_BONUS;
      refUser.referrals.push(address);
      const refNewAchievements = checkAchievements(refUser, {});
      saveData();
      send(ws, { type: "hello_ack", ...publicProfile(address) });
      sendToAddress(refAddress, {
        type: "referral_joined",
        profile: publicProfile(refAddress),
        newAchievements: refNewAchievements,
      });
      return;
    }

    // ---- matchmaking queue (TEST practice + PVP real-stake auto-match) ----
    if (msg.type === "queue_join") {
      if (hasActiveEngagement(address)) {
        send(ws, { type: "error", message: "already_in_a_duel" });
        return;
      }
      const matchType = msg.matchType === "test" ? "test" : "pvp";
      const size = SIZES.includes(msg.size) ? msg.size : 2;
      const practice = matchType === "test";
      const entryAmount = practice ? PRACTICE_ENTRY_AMOUNT : STAKES.includes(msg.entryAmount) ? msg.entryAmount : STAKES[0];
      const user = getUser(address);
      if (!practice && user.balance < entryAmount) {
        send(ws, { type: "error", message: "insufficient_balance" });
        return;
      }
      const bucketKey = `${matchType}:${entryAmount}:${size}`;
      let bucket = [...lobbies.values()].find(
        (l) => l.kind === "queue" && l.status === "queueing" && l.bucketKey === bucketKey
      );
      if (!bucket) {
        const id = randomUUID();
        bucket = {
          id,
          kind: "queue",
          matchType,
          bucketKey,
          size,
          entryAmount,
          practice,
          password: null,
          players: [],
          status: "queueing",
        };
        lobbies.set(id, bucket);
      }
      bucket.players.push({ address, nickname: user.nickname || "Anon", picks: [], ready: false });
      send(ws, { type: "queue_joined", lobbyId: bucket.id });
      maybeStartQueuedMatch(bucket);
      return;
    }

    if (msg.type === "create_lobby") {
      if (hasActiveEngagement(address)) {
        send(ws, { type: "error", message: "already_in_a_duel" });
        return;
      }
      const size = SIZES.includes(msg.size) ? msg.size : 2;
      if (!STAKES.includes(msg.entryAmount)) {
        send(ws, { type: "error", message: "insufficient_balance" });
        return;
      }
      const user = getUser(address);
      if (user.balance < msg.entryAmount) {
        send(ws, { type: "error", message: "insufficient_balance" });
        return;
      }
      const id = randomUUID();
      lobbies.set(id, {
        id,
        kind: "lobby",
        matchType: "lobby",
        size,
        entryAmount: msg.entryAmount,
        practice: false,
        password: msg.password ? String(msg.password).slice(0, 16) : null,
        players: [{ address, nickname: user.nickname || "Anon", picks: [], ready: false }],
        status: "queueing",
      });
      send(ws, { type: "queue_joined", lobbyId: id });
      broadcastLobbies();
      broadcastToLobby(lobbies.get(id), { type: "queue_update", lobbyId: id, ...queueSummary(lobbies.get(id)) });
      return;
    }

    if (msg.type === "join_lobby") {
      const lobby = lobbies.get(msg.lobbyId);
      if (!lobby || lobby.kind !== "lobby" || lobby.status !== "queueing") {
        send(ws, { type: "error", message: "lobby_unavailable" });
        return;
      }
      if (lobby.players.some((p) => p.address.toLowerCase() === address)) {
        send(ws, { type: "error", message: "already_in_a_duel" });
        return;
      }
      if (lobby.password && String(msg.password || "") !== lobby.password) {
        send(ws, { type: "error", message: "wrong_password" });
        return;
      }
      if (hasActiveEngagement(address)) {
        send(ws, { type: "error", message: "already_in_a_duel" });
        return;
      }
      const user = getUser(address);
      if (user.balance < lobby.entryAmount) {
        send(ws, { type: "error", message: "insufficient_balance" });
        return;
      }
      lobby.players.push({ address, nickname: user.nickname || "Anon", picks: [], ready: false });
      send(ws, { type: "queue_joined", lobbyId: lobby.id });
      maybeStartQueuedMatch(lobby);
      return;
    }

    if (msg.type === "cancel_queue") {
      const lobby = lobbies.get(msg.lobbyId);
      if (!lobby || lobby.status !== "queueing") return;
      lobby.players = lobby.players.filter((p) => p.address.toLowerCase() !== address);
      if (lobby.players.length === 0) {
        lobbies.delete(lobby.id);
      } else {
        broadcastToLobby(lobby, { type: "queue_update", lobbyId: lobby.id, ...queueSummary(lobby) });
      }
      broadcastLobbies();
      return;
    }

    if (msg.type === "submit_picks") {
      const lobby = lobbies.get(msg.lobbyId);
      if (!lobby || lobby.status !== "picking") {
        send(ws, { type: "error", message: "lobby_unavailable" });
        return;
      }
      const player = lobby.players.find((p) => p.address.toLowerCase() === address);
      if (!player) {
        send(ws, { type: "error", message: "not_registered" });
        return;
      }
      const picks = [...new Set(msg.picks || [])].filter((s) => ASSET_BINANCE[s]).slice(0, MAX_PICKS);
      if (picks.length === 0) {
        send(ws, { type: "error", message: "pick_at_least_one" });
        return;
      }
      player.picks = picks;
      player.ready = true;
      broadcastToLobby(lobby, {
        type: "pick_update",
        lobbyId: lobby.id,
        players: lobby.players.map((p) => ({ address: p.address, ready: p.ready })),
      });
      return;
    }
  });

  ws.on("close", () => {
    const address = unsubscribe(ws);
    if (!address) return;
    for (const lobby of [...lobbies.values()]) {
      if (lobby.status !== "queueing") continue;
      const wasIn = lobby.players.some((p) => p.address.toLowerCase() === address);
      if (!wasIn) continue;
      lobby.players = lobby.players.filter((p) => p.address.toLowerCase() !== address);
      if (lobby.players.length === 0) {
        lobbies.delete(lobby.id);
      } else {
        broadcastToLobby(lobby, { type: "queue_update", lobbyId: lobby.id, ...queueSummary(lobby) });
      }
      broadcastLobbies();
    }
  });
});

console.log(`Duel server listening on ws://localhost:${PORT}`);

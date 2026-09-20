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

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "data.json");
const PORT = Number(process.env.DUEL_SERVER_PORT) || 8787;
const DEFAULT_BALANCE = 1000;
const ROUND_SECONDS = 30;
const TICK_MS = 1000;
const PRICE_REFRESH_MS = 3000;
const MAX_PICKS = 4;
const ELO_K = 32;
const REFERRAL_SIGNUP_BONUS = 50; // credited to the new player
const REFERRAL_INVITER_BONUS = 25; // credited to whoever invited them
const HISTORY_LIMIT = 20;
const REFERRAL_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars

const ASSET_BINANCE = {
  ZEC: "ZECUSDT",
  NEAR: "NEARUSDT",
  ETH: "ETHUSDT",
  AAVE: "AAVEUSDT",
  BNB: "BNBUSDT",
  TRX: "TRXUSDT",
  SOL: "SOLUSDT",
  XRP: "XRPUSDT",
  DOGE: "DOGEUSDT",
  LTC: "LTCUSDT",
  ADA: "ADAUSDT",
  LINK: "LINKUSDT",
  DOT: "DOTUSDT",
  AVAX: "AVAXUSDT",
  SUI: "SUIUSDT",
  ARB: "ARBUSDT",
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

function sameBasket(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((s, i) => s === sb[i]);
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

function broadcastAll(msg) {
  for (const ws of wss.clients) send(ws, msg);
}

// ---- lobbies & active duels share one map, keyed by id ----
// { id, entryAmount, roundSeconds, host:{address,nickname,picks}, guest, status: open|active|done, symbols, entryPrices, history, startedAt }
const lobbies = new Map();

function lobbySummary(l) {
  const hostUser = getUser(l.host.address);
  return {
    id: l.id,
    entryAmount: l.entryAmount,
    hostAddress: l.host.address,
    hostNickname: l.host.nickname,
    hostPicks: l.host.picks,
    hostRating: Math.round(hostUser.rating),
    hostTier: tierFor(hostUser.rating),
  };
}

function broadcastLobbies() {
  const open = [...lobbies.values()].filter((l) => l.status === "open").map(lobbySummary);
  broadcastAll({ type: "lobbies", lobbies: open });
}

function hasActiveEngagement(address) {
  const key = address.toLowerCase();
  for (const l of lobbies.values()) {
    if (l.status === "open" && l.host.address.toLowerCase() === key) return true;
    if (l.status === "active" && (l.host.address.toLowerCase() === key || l.guest.address.toLowerCase() === key))
      return true;
  }
  return false;
}

// ---- Binance price cache shared across all active duels ----
const priceCache = new Map();

async function refreshPrices() {
  const symbols = new Set();
  for (const l of lobbies.values()) {
    if (l.status === "active") l.symbols.forEach((s) => symbols.add(s));
  }
  if (symbols.size === 0) return;
  try {
    const query = encodeURIComponent(JSON.stringify([...symbols]));
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${query}`);
    if (!res.ok) return;
    const rows = await res.json();
    for (const row of rows) priceCache.set(row.symbol, parseFloat(row.price));
  } catch {
    // transient hiccup — keep the stale cache, next refresh retries
  }
}
setInterval(refreshPrices, PRICE_REFRESH_MS);

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
  if (changes.some((c) => c == null)) return null;
  return changes.reduce((s, c) => s + c, 0) / changes.length;
}

function duelStartedPayload(lobby) {
  const hostUser = getUser(lobby.host.address);
  const guestUser = getUser(lobby.guest.address);
  return {
    type: "duel_started",
    lobbyId: lobby.id,
    entryAmount: lobby.entryAmount,
    roundSeconds: lobby.roundSeconds,
    players: {
      A: {
        address: lobby.host.address,
        nickname: lobby.host.nickname,
        picks: lobby.host.picks,
        rating: Math.round(hostUser.rating),
        tier: tierFor(hostUser.rating),
      },
      B: {
        address: lobby.guest.address,
        nickname: lobby.guest.nickname,
        picks: lobby.guest.picks,
        rating: Math.round(guestUser.rating),
        tier: tierFor(guestUser.rating),
      },
    },
  };
}

async function startDuel(lobby) {
  lobby.status = "active";
  lobby.symbols = [...new Set([...lobby.host.picks, ...lobby.guest.picks].map((s) => ASSET_BINANCE[s]))];
  const prices = await fetchPricesNow(lobby.symbols);
  const entryFor = (picks) => Object.fromEntries(picks.map((s) => [s, prices[ASSET_BINANCE[s]]]));
  lobby.entryPrices = { A: entryFor(lobby.host.picks), B: entryFor(lobby.guest.picks) };
  lobby.startedAt = Date.now();
  lobby.history = [];
  broadcastLobbies();

  const payload = duelStartedPayload(lobby);
  sendToAddress(lobby.host.address, payload);
  sendToAddress(lobby.guest.address, payload);
}

function tickDuel(lobby) {
  const elapsed = (Date.now() - lobby.startedAt) / 1000;
  const timeLeft = Math.max(lobby.roundSeconds - elapsed, 0);
  const liveA = Object.fromEntries(
    lobby.host.picks.map((s) => [ASSET_BINANCE[s], priceCache.get(ASSET_BINANCE[s])])
  );
  const liveB = Object.fromEntries(
    lobby.guest.picks.map((s) => [ASSET_BINANCE[s], priceCache.get(ASSET_BINANCE[s])])
  );
  const pctA = portfolioPct(lobby.host.picks, lobby.entryPrices.A, liveA);
  const pctB = portfolioPct(lobby.guest.picks, lobby.entryPrices.B, liveB);
  lobby.history.push({ t: Math.round((lobby.roundSeconds - timeLeft) * 10) / 10, pctA, pctB });

  const tickMsg = { type: "tick", lobbyId: lobby.id, timeLeft, pctA, pctB, history: lobby.history };
  sendToAddress(lobby.host.address, tickMsg);
  sendToAddress(lobby.guest.address, tickMsg);

  if (timeLeft <= 0) finishDuel(lobby, pctA ?? 0, pctB ?? 0);
}

function finishDuel(lobby, pctA, pctB) {
  lobby.status = "done";
  let winner = "tie";
  if (pctA > pctB) winner = "A";
  else if (pctB > pctA) winner = "B";

  const hostUser = getUser(lobby.host.address);
  const guestUser = getUser(lobby.guest.address);
  const oldHostRating = hostUser.rating;
  const oldGuestRating = guestUser.rating;

  if (winner === "A") {
    hostUser.balance += lobby.entryAmount;
    guestUser.balance -= lobby.entryAmount;
  } else if (winner === "B") {
    guestUser.balance += lobby.entryAmount;
    hostUser.balance -= lobby.entryAmount;
  }

  const scoreHost = winner === "A" ? 1 : winner === "B" ? 0 : 0.5;
  const scoreGuest = 1 - scoreHost;
  hostUser.rating = updateElo(oldHostRating, oldGuestRating, scoreHost);
  guestUser.rating = updateElo(oldGuestRating, oldHostRating, scoreGuest);

  if (winner === "A") {
    hostUser.wins += 1;
    guestUser.losses += 1;
    hostUser.streak = (hostUser.streak || 0) + 1;
    guestUser.streak = 0;
  } else if (winner === "B") {
    guestUser.wins += 1;
    hostUser.losses += 1;
    guestUser.streak = (guestUser.streak || 0) + 1;
    hostUser.streak = 0;
  } else {
    hostUser.ties += 1;
    guestUser.ties += 1;
    hostUser.streak = 0;
    guestUser.streak = 0;
  }
  hostUser.bestStreak = Math.max(hostUser.bestStreak || 0, hostUser.streak);
  guestUser.bestStreak = Math.max(guestUser.bestStreak || 0, guestUser.streak);

  const now = Date.now();
  hostUser.history.push({
    opponent: lobby.guest.address,
    opponentNickname: lobby.guest.nickname,
    entryAmount: lobby.entryAmount,
    picks: lobby.host.picks,
    oppPicks: lobby.guest.picks,
    pct: pctA,
    oppPct: pctB,
    result: winner === "A" ? "win" : winner === "B" ? "loss" : "tie",
    ratingDelta: Math.round(hostUser.rating - oldHostRating),
    timestamp: now,
  });
  hostUser.history = hostUser.history.slice(-HISTORY_LIMIT);
  guestUser.history.push({
    opponent: lobby.host.address,
    opponentNickname: lobby.host.nickname,
    entryAmount: lobby.entryAmount,
    picks: lobby.guest.picks,
    oppPicks: lobby.host.picks,
    pct: pctB,
    oppPct: pctA,
    result: winner === "B" ? "win" : winner === "A" ? "loss" : "tie",
    ratingDelta: Math.round(guestUser.rating - oldGuestRating),
    timestamp: now,
  });
  guestUser.history = guestUser.history.slice(-HISTORY_LIMIT);

  const hostNewAchievements = checkAchievements(hostUser, {
    won: winner === "A",
    entryAmount: lobby.entryAmount,
    picks: lobby.host.picks,
  });
  const guestNewAchievements = checkAchievements(guestUser, {
    won: winner === "B",
    entryAmount: lobby.entryAmount,
    picks: lobby.guest.picks,
  });

  saveData();

  const resultMsg = { type: "duel_result", lobbyId: lobby.id, winner, pctA, pctB, entryAmount: lobby.entryAmount };
  sendToAddress(lobby.host.address, {
    ...resultMsg,
    profile: publicProfile(lobby.host.address),
    newAchievements: hostNewAchievements,
  });
  sendToAddress(lobby.guest.address, {
    ...resultMsg,
    profile: publicProfile(lobby.guest.address),
    newAchievements: guestNewAchievements,
  });
  lobbies.delete(lobby.id);
}

setInterval(() => {
  for (const lobby of lobbies.values()) {
    if (lobby.status === "active") tickDuel(lobby);
  }
}, TICK_MS);

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
      send(ws, { type: "hello_ack", ...publicProfile(msg.address) });
      send(ws, {
        type: "lobbies",
        lobbies: [...lobbies.values()].filter((l) => l.status === "open").map(lobbySummary),
      });

      // resume an in-progress duel for a reconnecting player
      const key = msg.address.toLowerCase();
      for (const lobby of lobbies.values()) {
        if (
          lobby.status === "active" &&
          (lobby.host.address.toLowerCase() === key || lobby.guest.address.toLowerCase() === key)
        ) {
          send(ws, duelStartedPayload(lobby));
          const last = lobby.history.at(-1);
          send(ws, {
            type: "tick",
            lobbyId: lobby.id,
            timeLeft: Math.max(lobby.roundSeconds - (Date.now() - lobby.startedAt) / 1000, 0),
            pctA: last?.pctA ?? null,
            pctB: last?.pctB ?? null,
            history: lobby.history,
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

    if (msg.type === "create_lobby") {
      if (hasActiveEngagement(address)) {
        send(ws, { type: "error", message: "already_in_a_duel" });
        return;
      }
      const picks = [...new Set(msg.picks || [])].filter((s) => ASSET_BINANCE[s]).slice(0, MAX_PICKS);
      if (picks.length === 0) {
        send(ws, { type: "error", message: "pick_at_least_one" });
        return;
      }
      const user = getUser(address);
      if (!(msg.entryAmount > 0) || user.balance < msg.entryAmount) {
        send(ws, { type: "error", message: "insufficient_balance" });
        return;
      }
      const id = randomUUID();
      lobbies.set(id, {
        id,
        entryAmount: msg.entryAmount,
        roundSeconds: ROUND_SECONDS,
        host: { address, nickname: user.nickname || "Anon", picks },
        guest: null,
        status: "open",
      });
      broadcastLobbies();
      return;
    }

    if (msg.type === "cancel_lobby") {
      const lobby = lobbies.get(msg.lobbyId);
      if (lobby && lobby.status === "open" && lobby.host.address.toLowerCase() === address) {
        lobbies.delete(lobby.id);
        broadcastLobbies();
      }
      return;
    }

    if (msg.type === "join_lobby") {
      const lobby = lobbies.get(msg.lobbyId);
      if (!lobby || lobby.status !== "open") {
        send(ws, { type: "error", message: "lobby_unavailable" });
        return;
      }
      if (lobby.host.address.toLowerCase() === address) {
        send(ws, { type: "error", message: "cannot_join_own_lobby" });
        return;
      }
      if (hasActiveEngagement(address)) {
        send(ws, { type: "error", message: "already_in_a_duel" });
        return;
      }
      const picks = [...new Set(msg.picks || [])].filter((s) => ASSET_BINANCE[s]).slice(0, MAX_PICKS);
      if (picks.length === 0) {
        send(ws, { type: "error", message: "pick_at_least_one" });
        return;
      }
      if (sameBasket(picks, lobby.host.picks)) {
        send(ws, { type: "error", message: "same_basket" });
        return;
      }
      const user = getUser(address);
      if (user.balance < lobby.entryAmount) {
        send(ws, { type: "error", message: "insufficient_balance" });
        return;
      }
      const hostUser = getUser(lobby.host.address);
      if (hostUser.balance < lobby.entryAmount) {
        send(ws, { type: "error", message: "host_no_longer_has_balance" });
        lobbies.delete(lobby.id);
        broadcastLobbies();
        return;
      }

      lobby.guest = { address, nickname: user.nickname || "Anon", picks };
      startDuel(lobby).catch(() => {
        sendToAddress(lobby.host.address, { type: "error", message: "price_fetch_failed" });
        sendToAddress(address, { type: "error", message: "price_fetch_failed" });
        lobbies.delete(lobby.id);
        broadcastLobbies();
      });
      return;
    }
  });

  ws.on("close", () => {
    const address = unsubscribe(ws);
    if (!address) return;
    for (const lobby of [...lobbies.values()]) {
      if (lobby.status === "open" && lobby.host.address.toLowerCase() === address) {
        lobbies.delete(lobby.id);
        broadcastLobbies();
      }
    }
  });
});

console.log(`Duel server listening on ws://localhost:${PORT}`);

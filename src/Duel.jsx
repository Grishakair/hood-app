import { useEffect, useRef, useState } from "react";
import { useAccount, useDisconnect, useSignMessage } from "wagmi";
import { useAppKit } from "@reown/appkit/react";

// Real matchmaking against a WebSocket server (server/duelServer.js),
// virtual money only. Wallet = login, signed nickname, ELO-style rank,
// achievements, match history, referrals.
//
// Flow: connect -> nickname -> setup (pick TEST/PVP/LOBBY + stake) -> queue
// (auto-matched, or waiting on a private lobby link) -> picks (20s token
// pick window once the match is full) -> round (live) -> result. Matches
// are 1v1 or 5-player "Battleground" (winner takes the whole pot).
//
// Visual language follows the "Duel" design pass (paper background, Archivo
// Black numerals, Inter body, IBM Plex Mono for addresses/prices, a single
// green accent, red/green reserved for price direction).
//
// Temporary public tunnel (SSH reverse tunnel via localhost.run) to the dev
// machine's matchmaking server so this works from the deployed prod site too
// — it dies whenever that tunnel process stops, and localhost.run hands out
// a brand new random hostname on every restart. Rather than redeploy the
// whole site each time that happens, the actual URL lives in a tiny file in
// the repo (fetched fresh on every connection attempt) so restarting the
// tunnel only needs a one-line commit, not a rebuild. Set VITE_DUEL_WS_URL
// to override once there's a real always-on host for server/duelServer.js.
const WS_URL_FALLBACK = import.meta.env.VITE_DUEL_WS_URL || "wss://47cbc989727ef9.lhr.life";
const WS_URL_LOOKUP = "https://raw.githubusercontent.com/Grishakair/hood-app/main/public/duel-ws-url.txt";

async function resolveWsUrl() {
  try {
    const res = await fetch(`${WS_URL_LOOKUP}?t=${Date.now()}`, { cache: "no-store" });
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text.startsWith("ws://") || text.startsWith("wss://")) return text;
    }
  } catch {
    // network hiccup or lookup file missing — fall back below
  }
  return WS_URL_FALLBACK;
}

const MAX_PICKS = 4;
const STAKES = [10, 25, 50, 75];
const SIZES = [
  { size: 2, label: "1v1" },
  { size: 5, label: "Battleground" },
];
// Must mirror server/duelServer.js's ASSET_BINANCE (display symbol -> Binance
// ticker) — this is the 20-pair price oracle the pick grid reads from.
const ASSET_BINANCE = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT", BNB: "BNBUSDT", XRP: "XRPUSDT",
  ADA: "ADAUSDT", DOGE: "DOGEUSDT", AVAX: "AVAXUSDT", LINK: "LINKUSDT", DOT: "DOTUSDT",
  MATIC: "MATICUSDT", LTC: "LTCUSDT", TRX: "TRXUSDT", ATOM: "ATOMUSDT", NEAR: "NEARUSDT",
  ZEC: "ZECUSDT", AAVE: "AAVEUSDT", ARB: "ARBUSDT", OP: "OPUSDT", UNI: "UNIUSDT",
};
const ASSETS = Object.keys(ASSET_BINANCE);

const BG = "#F7F5F0";
const SURFACE2 = "#FFFFFF";
const LINE = "#E7E4DA";
const INK = "#0A0C10";
const SUB = "#6E6A5E";
const ACCENT = "#00A876";
const UP = "#00A876";
const DOWN = "#D1453B";
// Opponent-identity palette for the round chart (kept out of red/green,
// which are reserved for price direction). "You" is always ACCENT.
const PLAYER_COLORS = ["#3B5BFD", "#8B5CF6", "#C9A227", "#4FA89B"];

const TIER_DOT = {
  Bronze: "#B08968",
  Silver: "#9B9B93",
  Gold: "#C9A227",
  Platinum: "#4FA89B",
  Diamond: "#3B5BFD",
};

const ACHIEVEMENTS = {
  first_win: { emoji: "🥇", title: "First Win", desc: "Win your first duel" },
  win_streak_3: { emoji: "🔥", title: "3-Streak", desc: "Three wins in a row" },
  win_streak_5: { emoji: "🔥🔥", title: "5-Streak", desc: "Five wins in a row" },
  veteran_10: { emoji: "🎖️", title: "Veteran", desc: "Play 10 duels" },
  centurion_100: { emoji: "💯", title: "Centurion", desc: "Play 100 duels" },
  high_roller: { emoji: "💰", title: "High Roller", desc: "Win a duel with a $75 entry" },
  full_basket: { emoji: "🧺", title: "Full Basket", desc: "Win with 4 assets in your basket" },
  whale_200: { emoji: "🐳", title: "Whale", desc: "Earn $200 above your starting balance" },
  first_referral: { emoji: "🤝", title: "Ambassador", desc: "Invite your first friend" },
  battleground_win: { emoji: "👑", title: "Battleground Champ", desc: "Win a 5-player Battleground" },
};

const ERROR_TEXT = {
  not_registered: "Session isn't ready yet — try again.",
  bad_signature: "Signature didn't match — try again.",
  signature_failed: "Couldn't sign the message.",
  pick_at_least_one: "Pick at least one asset.",
  insufficient_balance: "Not enough virtual balance.",
  already_in_a_duel: "You already have an active match or queue.",
  lobby_unavailable: "This lobby is no longer available.",
  wrong_password: "Wrong lobby password.",
  price_fetch_failed: "Couldn't fetch prices — try again.",
  referral_already_set: "You already have a referrer.",
  invalid_referral_code: "Invalid referral code.",
};

function shortAddr(addr) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatPct(pct) {
  if (pct == null || Number.isNaN(pct)) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function formatUsd(n) {
  const sign = n > 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}

function formatClock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function pctColor(pct) {
  if (pct == null) return SUB;
  return pct >= 0 ? UP : DOWN;
}

function TierBadge({ tier, rating }) {
  return (
    <span style={styles.tierBadge}>
      <span style={{ ...styles.tierDot, background: TIER_DOT[tier] || SUB }} />
      {tier} · {rating}
    </span>
  );
}

function Chip({ active, disabled, onClick, children, style }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles.chip,
        ...(active ? styles.chipActive : {}),
        ...(disabled ? { opacity: 0.32, cursor: "not-allowed" } : {}),
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export default function Duel() {
  const { address, isConnected } = useAccount();
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();

  const [wsConnected, setWsConnected] = useState(false);
  const [profile, setProfile] = useState(null);
  const [publicLobbies, setPublicLobbies] = useState([]);
  const [dayChange, setDayChange] = useState({}); // binanceSymbol -> pct
  const [errorMsg, setErrorMsg] = useState("");
  const [toast, setToast] = useState(null);
  const [view, setView] = useState("setup"); // setup | profile | createLobby

  const [nicknameInput, setNicknameInput] = useState("");
  const [signingNickname, setSigningNickname] = useState(false);

  const [matchType, setMatchType] = useState("pvp"); // test | pvp | lobby
  const [stake, setStake] = useState(25);
  const [size, setSize] = useState(2);
  const [lobbyPassword, setLobbyPassword] = useState("");
  const [lobbySize, setLobbySize] = useState(2);
  const [lobbyStake, setLobbyStake] = useState(25);

  const [queueState, setQueueState] = useState(null); // {lobbyId, size, entryAmount, practice, players, hasPassword}
  const [pickState, setPickState] = useState(null); // {lobbyId, entryAmount, practice, size, players, deadlineAt}
  const [myPicks, setMyPicks] = useState([]);
  const [pickSearch, setPickSearch] = useState("");
  const [pickNow, setPickNow] = useState(Date.now());
  const [duel, setDuel] = useState(null);
  const [result, setResult] = useState(null);

  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const incomingRefRef = useRef(new URLSearchParams(window.location.search).get("ref"));
  const refAppliedRef = useRef(false);
  const incomingLobbyRef = useRef(new URLSearchParams(window.location.search).get("lobby"));
  const [joinLobbyId, setJoinLobbyId] = useState(incomingLobbyRef.current || null);
  const [joinPassword, setJoinPassword] = useState("");

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!pickState) return undefined;
    const t = setInterval(() => setPickNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [pickState]);

  useEffect(() => {
    if (!isConnected || !address) return undefined;

    let cancelled = false;

    async function connect() {
      const url = await resolveWsUrl();
      if (cancelled) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setWsConnected(true);
        ws.send(JSON.stringify({ type: "hello", address }));
      };

      ws.onclose = () => {
        if (cancelled) return;
        setWsConnected(false);
        reconnectTimer.current = setTimeout(connect, 2000);
      };

      ws.onerror = () => ws.close();

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.type === "hello_ack") {
          setProfile(msg);
          if (
            !refAppliedRef.current &&
            incomingRefRef.current &&
            !msg.referredBy &&
            msg.referralCode &&
            incomingRefRef.current.toUpperCase() !== msg.referralCode
          ) {
            refAppliedRef.current = true;
            ws.send(JSON.stringify({ type: "apply_referral", code: incomingRefRef.current }));
          }
        } else if (msg.type === "lobbies") {
          setPublicLobbies(msg.lobbies);
        } else if (msg.type === "day_change") {
          setDayChange(msg.values || {});
        } else if (msg.type === "queue_joined") {
          setErrorMsg("");
        } else if (msg.type === "queue_update") {
          setQueueState(msg);
        } else if (msg.type === "match_found") {
          setQueueState(null);
          setMyPicks([]);
          setPickSearch("");
          setPickState({ ...msg, deadlineAt: Date.now() + msg.pickSeconds * 1000 });
        } else if (msg.type === "pick_update") {
          setPickState((prev) =>
            prev && prev.lobbyId === msg.lobbyId
              ? { ...prev, players: prev.players.map((p) => ({ ...p, ready: msg.players.find((x) => x.address === p.address)?.ready ?? p.ready })) }
              : prev
          );
        } else if (msg.type === "duel_started") {
          setPickState(null);
          setResult(null);
          setDuel({
            lobbyId: msg.lobbyId,
            entryAmount: msg.entryAmount,
            practice: msg.practice,
            roundSeconds: msg.roundSeconds,
            players: msg.players,
            timeLeft: msg.roundSeconds,
            pct: {},
            history: [],
          });
        } else if (msg.type === "tick") {
          setDuel((prev) =>
            prev && prev.lobbyId === msg.lobbyId
              ? { ...prev, timeLeft: msg.timeLeft, pct: msg.pct, history: msg.history }
              : prev
          );
        } else if (msg.type === "duel_result") {
          setResult({ entryAmount: msg.entryAmount, practice: msg.practice, ranking: msg.ranking });
          if (msg.profile) setProfile((prev) => ({ ...prev, ...msg.profile }));
          if (msg.newAchievements?.length) {
            setToast(`🏆 New achievement: ${msg.newAchievements.map((id) => ACHIEVEMENTS[id]?.title || id).join(", ")}`);
          }
        } else if (msg.type === "referral_joined") {
          setProfile(msg.profile);
          if (msg.newAchievements?.length) {
            setToast(`🤝 New referral! ${msg.newAchievements.map((id) => ACHIEVEMENTS[id]?.title || id).join(", ")}`);
          } else {
            setToast("🤝 Someone signed up with your link — bonus credited.");
          }
        } else if (msg.type === "error") {
          setErrorMsg(ERROR_TEXT[msg.message] || msg.message);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [isConnected, address]);

  function wsSend(obj) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(obj));
    }
  }

  async function saveNickname() {
    if (!nicknameInput.trim()) return;
    setErrorMsg("");
    setSigningNickname(true);
    try {
      const message = `Set nickname to "${nicknameInput.trim()}" for Last Dance`;
      const signature = await signMessageAsync({ message });
      wsSend({ type: "set_nickname", nickname: nicknameInput.trim(), message, signature });
    } catch {
      setErrorMsg("Signature cancelled.");
    } finally {
      setSigningNickname(false);
    }
  }

  function findMatch() {
    setErrorMsg("");
    if (matchType === "test") {
      wsSend({ type: "queue_join", matchType: "test", size: 2 });
    } else {
      wsSend({ type: "queue_join", matchType: "pvp", size, entryAmount: stake });
    }
  }

  function createLobby() {
    setErrorMsg("");
    wsSend({ type: "create_lobby", size: lobbySize, entryAmount: lobbyStake, password: lobbyPassword || null });
    setView("setup");
  }

  function joinPublicLobby(lobbyId) {
    setErrorMsg("");
    wsSend({ type: "join_lobby", lobbyId });
  }

  function joinByLink() {
    if (!joinLobbyId) return;
    setErrorMsg("");
    wsSend({ type: "join_lobby", lobbyId: joinLobbyId, password: joinPassword });
    setJoinLobbyId(null);
  }

  function cancelQueue() {
    if (!queueState) return;
    wsSend({ type: "cancel_queue", lobbyId: queueState.lobbyId });
    setQueueState(null);
  }

  function toggleMyPick(sym) {
    setMyPicks((prev) => {
      if (prev.includes(sym)) return prev.filter((s) => s !== sym);
      if (prev.length >= MAX_PICKS) return prev;
      return [...prev, sym];
    });
  }

  function submitPicks() {
    if (!pickState || myPicks.length === 0) return;
    wsSend({ type: "submit_picks", lobbyId: pickState.lobbyId, picks: myPicks });
  }

  function backToMenu() {
    setDuel(null);
    setResult(null);
    setView("setup");
  }

  let phase = "connect";
  if (isConnected) {
    if (!wsConnected) phase = "connecting";
    else if (!profile?.nickname) phase = "nickname";
    else if (joinLobbyId) phase = "joinLobby";
    else if (duel && !result) phase = "round";
    else if (result) phase = "result";
    else if (pickState) phase = "picks";
    else if (queueState) phase = "queue";
    else if (view === "createLobby") phase = "createLobby";
    else if (view === "profile") phase = "profile";
    else phase = "setup";
  }

  return (
    <div style={styles.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600;700&family=Archivo+Black&display=swap');
      `}</style>
      <div style={styles.card}>
        {profile?.nickname && ["setup", "profile", "createLobby"].includes(phase) && (
          <button style={styles.profileCorner} onClick={() => setView(view === "profile" ? "setup" : "profile")}>
            {view === "profile" ? "🎮 Game" : "👤 Profile"}
          </button>
        )}

        <div style={styles.header}>
          <span style={styles.headerTitle}>Duel</span>
          <span style={styles.headerSub}>Pick a basket. Highest % after the round takes the pot.</span>
        </div>

        {profile?.nickname && (
          <div style={styles.topBar}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>
                {profile.nickname} <span style={{ color: SUB }}>· {shortAddr(address)}</span>
              </span>
              <TierBadge tier={profile.tier} rating={profile.rating} />
            </div>
            <span style={styles.balance}>${profile.balance?.toFixed(2)}</span>
          </div>
        )}

        {toast && <div style={styles.toast}>{toast}</div>}

        {phase === "connect" && (
          <div style={styles.section}>
            <div style={styles.hint}>Connecting doubles as your login — no email, no password.</div>
            <button style={styles.primaryBtn} onClick={() => open()}>
              Connect wallet
            </button>
          </div>
        )}

        {phase === "connecting" && <div style={styles.hint}>Connecting to server…</div>}

        {phase === "nickname" && (
          <div style={{ ...styles.section, alignItems: "center", textAlign: "center" }}>
            <div style={styles.label}>Pick a nickname</div>
            <input
              style={{ ...styles.input, maxWidth: 220, textAlign: "center" }}
              value={nicknameInput}
              onChange={(e) => setNicknameInput(e.target.value)}
              maxLength={20}
              placeholder="e.g. KLINE"
            />
            {errorMsg && <div style={styles.error}>{errorMsg}</div>}
            <button
              style={{ ...styles.primaryBtn, maxWidth: 220 }}
              onClick={saveNickname}
              disabled={signingNickname}
            >
              {signingNickname ? "Sign in your wallet…" : "Sign & Save"}
            </button>
            <div style={styles.hint}>Signing is free — it just proves this address picked this name.</div>
          </div>
        )}

        {phase === "joinLobby" && (
          <div style={styles.section}>
            <div style={styles.label}>Join private lobby</div>
            <div style={styles.hint}>You were sent a lobby link. Enter the password if it has one.</div>
            <input
              style={styles.input}
              value={joinPassword}
              onChange={(e) => setJoinPassword(e.target.value)}
              placeholder="Password (if any)"
            />
            {errorMsg && <div style={styles.error}>{errorMsg}</div>}
            <button style={styles.primaryBtn} onClick={joinByLink}>
              Join lobby
            </button>
            <button style={styles.secondaryBtn} onClick={() => setJoinLobbyId(null)}>
              skip, go to menu
            </button>
          </div>
        )}

        {phase === "setup" && (
          <SetupScreen
            balance={profile.balance}
            matchType={matchType}
            setMatchType={setMatchType}
            stake={stake}
            setStake={setStake}
            size={size}
            setSize={setSize}
            publicLobbies={publicLobbies}
            onFindMatch={findMatch}
            onGoCreateLobby={() => setView("createLobby")}
            onJoinPublicLobby={joinPublicLobby}
            errorMsg={errorMsg}
          />
        )}

        {phase === "createLobby" && (
          <CreateLobbyScreen
            lobbySize={lobbySize}
            setLobbySize={setLobbySize}
            lobbyStake={lobbyStake}
            setLobbyStake={setLobbyStake}
            lobbyPassword={lobbyPassword}
            setLobbyPassword={setLobbyPassword}
            balance={profile.balance}
            onCreate={createLobby}
            onBack={() => setView("setup")}
          />
        )}

        {phase === "queue" && (
          <QueueScreen queueState={queueState} myAddress={address} onCancel={cancelQueue} />
        )}

        {phase === "picks" && pickState && (
          <PicksScreen
            pickState={pickState}
            myPicks={myPicks}
            onToggle={toggleMyPick}
            onSubmit={submitPicks}
            pickSearch={pickSearch}
            setPickSearch={setPickSearch}
            dayChange={dayChange}
            secondsLeft={Math.max(0, (pickState.deadlineAt - pickNow) / 1000)}
          />
        )}

        {phase === "round" && duel && <RoundScreen duel={duel} myAddress={address} />}

        {phase === "result" && result && (
          <ResultScreen result={result} myAddress={address} onBack={backToMenu} />
        )}

        {phase === "profile" && <ProfileScreen profile={profile} />}

        {profile?.nickname && (
          <button style={styles.disconnectBtn} onClick={() => disconnect()}>
            disconnect wallet
          </button>
        )}
      </div>
    </div>
  );
}

function SetupScreen({
  balance,
  matchType,
  setMatchType,
  stake,
  setStake,
  size,
  setSize,
  publicLobbies,
  onFindMatch,
  onGoCreateLobby,
  onJoinPublicLobby,
  errorMsg,
}) {
  const canAfford = matchType === "test" || balance >= stake;
  return (
    <div style={styles.section}>
      <div style={styles.label}>Match type</div>
      <div style={styles.chipRow}>
        <Chip active={matchType === "test"} onClick={() => setMatchType("test")}>
          <div style={{ fontWeight: 800 }}>TEST</div>
          <div style={{ fontSize: 11, opacity: 0.75 }}>1v1 · virtual</div>
        </Chip>
        <Chip active={matchType === "pvp"} onClick={() => setMatchType("pvp")}>
          <div style={{ fontWeight: 800 }}>PVP</div>
          <div style={{ fontSize: 11, opacity: 0.75 }}>real balance</div>
        </Chip>
        <Chip active={matchType === "lobby"} onClick={() => setMatchType("lobby")}>
          <div style={{ fontWeight: 800 }}>LOBBY</div>
          <div style={{ fontSize: 11, opacity: 0.75 }}>invite a friend</div>
        </Chip>
      </div>

      {matchType === "pvp" && (
        <>
          <div style={{ ...styles.label, marginTop: 14 }}>Game size</div>
          <div style={styles.chipRow}>
            {SIZES.map((s) => (
              <Chip key={s.size} active={size === s.size} onClick={() => setSize(s.size)}>
                {s.label}
              </Chip>
            ))}
          </div>

          <div style={{ ...styles.label, marginTop: 14 }}>Stake</div>
          <div style={styles.chipRow}>
            {STAKES.map((amt) => (
              <Chip key={amt} active={stake === amt} disabled={balance < amt} onClick={() => setStake(amt)}>
                ${amt}
              </Chip>
            ))}
          </div>
          <div style={styles.potPreview}>
            Pot: ${(stake * size).toFixed(0)} · winner takes {size === 2 ? "it all" : "the whole pot"}
          </div>
        </>
      )}

      {matchType === "test" && (
        <div style={styles.note}>Practice match — virtual funds. Doesn't touch your real balance or record.</div>
      )}

      <div style={styles.hint}>You'll pick your tokens right after the match is found.</div>
      {errorMsg && <div style={styles.error}>{errorMsg}</div>}

      {matchType === "lobby" ? (
        <button style={styles.primaryBtn} onClick={onGoCreateLobby}>
          Create Lobby
        </button>
      ) : (
        <button style={styles.primaryBtn} disabled={!canAfford} onClick={onFindMatch}>
          Find Match
        </button>
      )}
      <div style={styles.hint}>Average search time: 5–10 sec.</div>

      {matchType === "lobby" && (
        <>
          <div style={{ ...styles.label, marginTop: 18 }}>Open invites</div>
          {publicLobbies.length === 0 && <div style={styles.hint}>No open public lobbies right now.</div>}
          {publicLobbies.map((l) => (
            <div key={l.id} style={styles.lobbyRow}>
              <div>
                <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
                  {l.hostNickname}
                  <TierBadge tier={l.hostTier} rating={l.hostRating} />
                </div>
                <div style={styles.rowSub}>
                  ${l.entryAmount} · {l.size === 5 ? "Battleground" : "1v1"} · {l.slotsFilled}/{l.size} joined
                </div>
              </div>
              <button style={styles.joinBtn} disabled={balance < l.entryAmount} onClick={() => onJoinPublicLobby(l.id)}>
                join
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function CreateLobbyScreen({ lobbySize, setLobbySize, lobbyStake, setLobbyStake, lobbyPassword, setLobbyPassword, balance, onCreate, onBack }) {
  return (
    <div style={styles.section}>
      <div style={styles.label}>Game type</div>
      <div style={styles.chipRow}>
        {SIZES.map((s) => (
          <Chip key={s.size} active={lobbySize === s.size} onClick={() => setLobbySize(s.size)}>
            {s.label}
          </Chip>
        ))}
      </div>
      <div style={{ ...styles.label, marginTop: 14 }}>Stake</div>
      <div style={styles.chipRow}>
        {STAKES.map((amt) => (
          <Chip key={amt} active={lobbyStake === amt} disabled={balance < amt} onClick={() => setLobbyStake(amt)}>
            ${amt}
          </Chip>
        ))}
      </div>
      <div style={{ ...styles.label, marginTop: 14 }}>Password (optional)</div>
      <input
        style={styles.input}
        value={lobbyPassword}
        onChange={(e) => setLobbyPassword(e.target.value)}
        placeholder="Leave blank for open invite"
        maxLength={16}
      />
      <div style={styles.hint}>Anyone with the link can join — add a password to keep it private.</div>
      <button style={styles.primaryBtn} disabled={balance < lobbyStake} onClick={onCreate}>
        Create Lobby
      </button>
      <button style={styles.secondaryBtn} onClick={onBack}>
        back
      </button>
    </div>
  );
}

function QueueScreen({ queueState, myAddress, onCancel }) {
  if (!queueState) return null;
  const slots = Array.from({ length: queueState.size }, (_, i) => queueState.players[i] || null);
  return (
    <div style={{ ...styles.section, alignItems: "center", textAlign: "center" }}>
      {queueState.kind === "lobby" && (
        <div style={{ ...styles.hint, marginBottom: 4 }}>
          Lobby link:{" "}
          <button
            style={styles.linkBtn}
            onClick={() => navigator.clipboard?.writeText(`${window.location.origin}${window.location.pathname}?lobby=${queueState.lobbyId}`)}
          >
            copy invite link
          </button>
        </div>
      )}
      <div style={{ ...styles.label, fontSize: 17, color: INK }}>
        {queueState.players.length >= queueState.size ? "Match found" : "Searching for opponents…"}
      </div>
      <div style={styles.hint}>
        {queueState.practice ? "Practice" : `$${queueState.entryAmount} stake`} · {queueState.size === 5 ? "Battleground" : "1v1"}
      </div>
      <div style={styles.queueCount}>
        {queueState.players.length} / {queueState.size}
      </div>
      <div style={styles.queueSlots}>
        {slots.map((p, i) => {
          const isYou = p?.address?.toLowerCase() === myAddress?.toLowerCase();
          return (
            <div
              key={i}
              style={{
                ...styles.queueSlot,
                ...(p ? styles.queueSlotFilled : {}),
                ...(isYou ? styles.queueSlotYou : {}),
              }}
            >
              {p ? p.nickname : "…"}
            </div>
          );
        })}
      </div>
      <button style={styles.secondaryBtn} onClick={onCancel}>
        cancel search
      </button>
    </div>
  );
}

function PicksScreen({ pickState, myPicks, onToggle, onSubmit, pickSearch, setPickSearch, dayChange, secondsLeft }) {
  const readyCount = pickState.players.filter((p) => p.ready).length;
  const filtered = ASSETS.filter((a) => a.toLowerCase().includes(pickSearch.trim().toLowerCase()));
  return (
    <div style={{ ...styles.section, alignItems: "center", textAlign: "center" }}>
      <div style={{ ...styles.label, fontSize: 17, color: INK }}>Pick your tokens</div>
      <div style={styles.pickTimer}>{formatClock(secondsLeft)}</div>
      <div style={styles.hint}>
        {myPicks.length} / {MAX_PICKS} selected · {readyCount}/{pickState.players.length} players ready
      </div>
      <input
        style={{ ...styles.input, maxWidth: 360 }}
        value={pickSearch}
        onChange={(e) => setPickSearch(e.target.value)}
        placeholder="Search token…"
      />
      <div style={styles.tokenGrid}>
        {filtered.map((sym) => {
          const active = myPicks.includes(sym);
          const disabled = !active && myPicks.length >= MAX_PICKS;
          const pct = dayChange[ASSET_BINANCE[sym]];
          return (
            <button
              key={sym}
              onClick={() => onToggle(sym)}
              disabled={disabled}
              style={{
                ...styles.tokenChip,
                ...(active ? styles.chipActive : {}),
                ...(disabled ? { opacity: 0.32, cursor: "not-allowed" } : {}),
              }}
            >
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, fontSize: 12.5 }}>{sym}</span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 700, color: active ? "inherit" : pctColor(pct) }}>
                {pct != null ? formatPct(pct) : "—"}
              </span>
            </button>
          );
        })}
      </div>
      <button style={{ ...styles.primaryBtn, maxWidth: 360 }} disabled={myPicks.length === 0} onClick={onSubmit}>
        Ready
      </button>
    </div>
  );
}

function PlayerRow({ p, isYou, colorIdx, pct, leading }) {
  const color = isYou ? ACCENT : PLAYER_COLORS[colorIdx % PLAYER_COLORS.length];
  return (
    <div style={styles.playerChip}>
      <div style={{ ...styles.avatarSm, ...(isYou ? { background: ACCENT, borderColor: ACCENT, color: "#000" } : { borderColor: color, color }) }}>
        {p.nickname.slice(0, 2).toUpperCase()}
      </div>
      <div style={styles.playerChipName}>
        {p.nickname}
        {leading && " 👑"}
      </div>
      <div style={{ ...styles.playerChipPct, color: pctColor(pct) }}>{formatPct(pct)}</div>
    </div>
  );
}

function RoundChart({ history, players, myAddress, roundSeconds }) {
  const W = 400;
  const H = 200;
  const PAD = 8;
  const addresses = players.map((p) => p.address.toLowerCase());
  const allVals = history.flatMap((h) => addresses.map((a) => h.pct?.[a]).filter((v) => v != null));
  const all = [...allVals, 0];
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) {
    min -= 0.1;
    max += 0.1;
  }
  const pad = (max - min) * 0.15 || 0.1;
  min -= pad;
  max += pad;

  const xFor = (t) => PAD + (t / roundSeconds) * (W - 2 * PAD);
  const yFor = (v) => H - PAD - ((v - min) / (max - min)) * (H - 2 * PAD);
  const zeroY = yFor(0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={styles.roundChart}>
      <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke={LINE} strokeDasharray="4 4" />
      {addresses.map((addr, i) => {
        const isYou = addr === myAddress?.toLowerCase();
        const pts = history
          .filter((h) => h.pct?.[addr] != null)
          .map((h) => `${xFor(h.t)},${yFor(h.pct[addr])}`)
          .join(" ");
        if (!pts) return null;
        const color = isYou ? ACCENT : PLAYER_COLORS[i % PLAYER_COLORS.length];
        return <polyline key={addr} points={pts} fill="none" stroke={color} strokeWidth={isYou ? 3.5 : 2.5} opacity={isYou ? 1 : 0.85} />;
      })}
    </svg>
  );
}

function RankingList({ ranked, myAddress }) {
  return (
    <div style={styles.rankingList}>
      {ranked.map((r, i) => {
        const isYou = r.address.toLowerCase() === myAddress?.toLowerCase();
        return (
          <div key={r.address} style={{ ...styles.rankRow, ...(i === 0 ? styles.rankRowLead : {}) }}>
            <div style={styles.rankRowMain}>
              <span style={styles.rankNum}>{i + 1}</span>
              <span style={styles.rankName}>
                {r.nickname}
                {isYou ? " (you)" : ""}
              </span>
              <span style={{ ...styles.rankPct, color: pctColor(r.pct) }}>{formatPct(r.pct)}</span>
            </div>
            <div style={styles.rankTokens}>{r.picks.join(" · ")}</div>
          </div>
        );
      })}
    </div>
  );
}

function RoundScreen({ duel, myAddress }) {
  const { players, timeLeft, pct, entryAmount, history, roundSeconds, practice } = duel;
  const ranked = [...players]
    .map((p) => ({ ...p, pct: pct[p.address.toLowerCase()] ?? null }))
    .sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity));
  const leaderAddr = ranked[0]?.address?.toLowerCase();

  return (
    <div style={styles.section}>
      {practice && <div style={styles.note}>Practice match — virtual funds only.</div>}
      <div style={styles.timer}>{formatClock(timeLeft)}</div>
      <div style={styles.playersRow}>
        {players.map((p, i) => (
          <PlayerRow
            key={p.address}
            p={p}
            isYou={p.address.toLowerCase() === myAddress?.toLowerCase()}
            colorIdx={i}
            pct={pct[p.address.toLowerCase()]}
            leading={p.address.toLowerCase() === leaderAddr}
          />
        ))}
      </div>
      <RoundChart history={history} players={players} myAddress={myAddress} roundSeconds={roundSeconds} />
      <RankingList ranked={ranked} myAddress={myAddress} />
      <div style={styles.hint}>{practice ? "Practice round" : `Pot: $${(entryAmount * players.length).toFixed(0)}`}</div>
    </div>
  );
}

function ResultScreen({ result, myAddress, onBack }) {
  const { ranking, entryAmount, practice } = result;
  const me = ranking.find((r) => r.address.toLowerCase() === myAddress?.toLowerCase());
  const iWon = !!me?.won;
  return (
    <div style={styles.section}>
      {practice ? (
        <div style={styles.resultBanner}>Practice round — no funds moved.</div>
      ) : (
        <div style={{ ...styles.resultBanner, ...(iWon ? styles.resultBannerWin : {}) }}>
          {iWon ? `You won $${me.net.toFixed(2)}` : `You lost $${entryAmount.toFixed(2)}`}
        </div>
      )}
      <RankingList ranked={ranking} myAddress={myAddress} />
      <button style={styles.primaryBtn} onClick={onBack}>
        Back to Menu
      </button>
    </div>
  );
}

function ProfileScreen({ profile }) {
  const [copied, setCopied] = useState(false);
  const total = profile.wins + profile.losses + profile.ties;
  const winRate = total > 0 ? Math.round((profile.wins / total) * 100) : 0;
  const refLink = `${window.location.origin}${window.location.pathname}?ref=${profile.referralCode}`;

  function copyLink() {
    navigator.clipboard?.writeText(refLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div style={styles.section}>
      <div style={styles.statsGrid}>
        <div style={styles.statBox}>
          <div style={styles.statValue}>
            {profile.wins}-{profile.losses}-{profile.ties}
          </div>
          <div style={styles.rowSub}>wins-losses-ties · {winRate}%</div>
        </div>
        <div style={styles.statBox}>
          <div style={styles.statValue}>{profile.streak}</div>
          <div style={styles.rowSub}>current streak (best {profile.bestStreak})</div>
        </div>
      </div>

      <div style={{ ...styles.label, marginTop: 16 }}>Achievements</div>
      <div style={styles.achGrid}>
        {Object.entries(ACHIEVEMENTS).map(([id, a]) => {
          const unlocked = profile.achievements.includes(id);
          return (
            <div key={id} style={{ ...styles.achCard, opacity: unlocked ? 1 : 0.3 }} title={a.desc}>
              <div style={{ fontSize: 22 }}>{a.emoji}</div>
              <div style={styles.achTitle}>{a.title}</div>
            </div>
          );
        })}
      </div>

      <div style={{ ...styles.label, marginTop: 16 }}>Invite a friend</div>
      <div style={styles.lobbyRow}>
        <div>
          <div style={{ fontWeight: 700 }}>{profile.referralCode}</div>
          <div style={styles.rowSub}>
            Joined via your link: {profile.referralCount} · you get +$25, they get +$50
          </div>
        </div>
        <button style={styles.joinBtn} onClick={copyLink}>
          {copied ? "copied" : "copy link"}
        </button>
      </div>

      <div style={{ ...styles.label, marginTop: 16 }}>Recent games</div>
      {profile.history.length === 0 && <div style={styles.hint}>Nothing yet — play your first duel.</div>}
      {profile.history.map((h, i) => (
        <div key={i} style={styles.lobbyRow}>
          <div>
            <div style={{ fontWeight: 700 }}>
              {h.result === "win" ? "Win" : "Loss"} vs {h.opponentNickname}
              {h.size > 2 ? ` (+${h.size - 2} more)` : ""}
            </div>
            <div style={styles.rowSub}>
              ${h.entryAmount} · {formatPct(h.pct)}
            </div>
          </div>
          <div style={{ color: INK, fontWeight: 700 }}>
            {h.ratingDelta >= 0 ? "+" : ""}
            {h.ratingDelta}
          </div>
        </div>
      ))}
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: BG,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "'Inter', sans-serif",
    color: INK,
    padding: 20,
  },
  card: {
    position: "relative",
    width: 440,
    maxWidth: "100%",
    background: BG,
    border: `1px solid ${LINE}`,
    borderRadius: 24,
    padding: 24,
    boxShadow: "0 30px 60px rgba(10,12,16,.08)",
  },
  profileCorner: {
    position: "absolute",
    top: 16,
    right: 16,
    padding: "4px 10px",
    border: `1px solid ${LINE}`,
    borderRadius: 10,
    background: "transparent",
    color: SUB,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 11,
    fontWeight: 700,
  },
  header: { marginBottom: 16, textAlign: "center" },
  headerTitle: { display: "block", fontFamily: "'Archivo Black', sans-serif", fontSize: 26, color: INK },
  headerSub: { display: "block", fontSize: 12, color: SUB, marginTop: 4, fontWeight: 500 },
  topBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 13,
    fontWeight: 600,
    color: INK,
    padding: "10px 14px",
    border: `1px solid ${LINE}`,
    borderRadius: 12,
    marginBottom: 12,
    background: SURFACE2,
  },
  balance: { color: INK, fontWeight: 700, fontFamily: "'Archivo Black', sans-serif" },
  tierBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11,
    fontWeight: 700,
    border: `1px solid ${LINE}`,
    borderRadius: 8,
    padding: "2px 6px",
    width: "fit-content",
    color: SUB,
  },
  tierDot: { width: 6, height: 6, borderRadius: 3, display: "inline-block" },
  toast: {
    background: SURFACE2,
    border: `1px solid ${INK}`,
    borderRadius: 12,
    color: INK,
    fontSize: 12,
    fontWeight: 600,
    padding: "8px 12px",
    marginBottom: 12,
    textAlign: "center",
  },
  section: { display: "flex", flexDirection: "column" },
  label: { fontSize: 13, color: SUB, marginBottom: 8, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4 },
  chipRow: { display: "flex", gap: 8, marginBottom: 4 },
  chip: {
    flex: 1,
    padding: "13px 4px",
    border: `1px solid ${LINE}`,
    borderRadius: 13,
    background: "transparent",
    color: INK,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 14,
    fontWeight: 700,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
  },
  chipActive: { background: ACCENT, color: "#000", borderColor: ACCENT },
  potPreview: { fontSize: 13, color: SUB, margin: "4px 0", fontWeight: 500 },
  note: { fontSize: 13, color: SUB, lineHeight: 1.5, margin: "10px 0", fontWeight: 500 },
  tokenGrid: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, margin: "8px 0 16px", width: "100%", maxWidth: 360 },
  tokenChip: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 3,
    padding: "11px 0 9px",
    border: `1px solid ${LINE}`,
    borderRadius: 12,
    background: "transparent",
    color: INK,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  input: {
    width: "100%",
    padding: "14px 15px",
    border: `1px solid ${LINE}`,
    borderRadius: 12,
    background: SURFACE2,
    color: INK,
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 14,
    marginBottom: 12,
  },
  primaryBtn: {
    marginTop: 8,
    padding: "16px 0",
    border: "none",
    borderRadius: 14,
    background: INK,
    color: BG,
    fontFamily: "'Inter', sans-serif",
    fontSize: 15.5,
    fontWeight: 700,
    cursor: "pointer",
  },
  secondaryBtn: {
    marginTop: 10,
    padding: "13px 0",
    border: `1px solid ${LINE}`,
    borderRadius: 14,
    background: "transparent",
    color: INK,
    fontFamily: "inherit",
    fontSize: 13.5,
    fontWeight: 700,
    cursor: "pointer",
  },
  linkBtn: {
    border: "none",
    background: "none",
    color: INK,
    textDecoration: "underline",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: "inherit",
    padding: 0,
  },
  disconnectBtn: {
    marginTop: 16,
    padding: "8px 0",
    border: "none",
    background: "transparent",
    color: SUB,
    fontFamily: "inherit",
    fontSize: 12,
    cursor: "pointer",
    textDecoration: "underline",
  },
  hint: { marginTop: 8, marginBottom: 8, fontSize: 12, color: SUB, textAlign: "center", fontWeight: 500 },
  error: { color: DOWN, fontSize: 13, marginBottom: 12, fontWeight: 600 },
  timer: {
    textAlign: "center",
    fontFamily: "'Archivo Black', sans-serif",
    fontSize: 38,
    color: INK,
    marginBottom: 12,
    fontVariantNumeric: "tabular-nums",
  },
  pickTimer: {
    textAlign: "center",
    fontFamily: "'Archivo Black', sans-serif",
    fontSize: 38,
    color: INK,
    margin: "6px 0 4px",
    fontVariantNumeric: "tabular-nums",
  },
  lobbyRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 14px",
    border: `1px solid ${LINE}`,
    borderRadius: 12,
    marginBottom: 10,
    background: SURFACE2,
  },
  rowSub: { fontSize: 12, color: SUB, fontWeight: 500 },
  joinBtn: {
    padding: "8px 16px",
    border: `1px solid ${INK}`,
    borderRadius: 10,
    background: "transparent",
    color: INK,
    fontFamily: "inherit",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
  queueCount: { fontFamily: "'Archivo Black', sans-serif", fontSize: 44, marginBottom: 6, fontVariantNumeric: "tabular-nums" },
  queueSlots: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 10, margin: "12px 0 20px" },
  queueSlot: {
    minWidth: 60,
    maxWidth: 120,
    height: 60,
    padding: "0 12px",
    borderRadius: 16,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 13,
    border: `1.5px dashed ${LINE}`,
    color: SUB,
    fontWeight: 700,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  queueSlotFilled: { borderStyle: "solid", borderWidth: 1.5, borderColor: INK, color: INK, fontWeight: 800 },
  queueSlotYou: { background: ACCENT, borderColor: ACCENT, color: "#000" },
  playersRow: { display: "flex", justifyContent: "space-between", gap: 6, marginBottom: 14, flexWrap: "wrap" },
  playerChip: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flex: 1, minWidth: 60 },
  avatarSm: {
    width: 38,
    height: 38,
    borderRadius: 11,
    border: "1.5px solid",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 12,
    fontWeight: 700,
  },
  playerChipName: { fontSize: 12, fontWeight: 800, color: INK, maxWidth: 70, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  playerChipPct: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, fontWeight: 700 },
  roundChart: { width: "100%", height: 200, display: "block", marginBottom: 14 },
  rankingList: { display: "flex", flexDirection: "column", marginBottom: 8 },
  rankRow: { display: "flex", flexDirection: "column", gap: 4, padding: "12px 4px", borderBottom: `1px solid ${LINE}`, fontSize: 13 },
  rankRowLead: { borderLeft: `3px solid ${ACCENT}`, paddingLeft: 11, marginLeft: -3 },
  rankRowMain: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  rankNum: { color: SUB, width: 18, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700 },
  rankName: { flex: 1, textAlign: "left", padding: "0 8px", fontWeight: 800, fontSize: 15 },
  rankPct: { fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, fontSize: 15 },
  rankTokens: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, paddingLeft: 26, textAlign: "left", color: SUB },
  resultBanner: {
    textAlign: "center",
    fontSize: 18,
    fontWeight: 800,
    color: INK,
    border: `1.5px solid ${LINE}`,
    borderRadius: 16,
    padding: "20px 12px",
    marginBottom: 16,
    background: "transparent",
  },
  resultBannerWin: { borderColor: ACCENT, borderWidth: 2 },
  statsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  statBox: {
    padding: "12px 14px",
    border: `1px solid ${LINE}`,
    borderRadius: 14,
    textAlign: "center",
  },
  statValue: { fontFamily: "'Archivo Black', sans-serif", fontSize: 20, color: INK },
  achGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 },
  achCard: {
    padding: "16px 6px",
    border: `1.5px solid ${LINE}`,
    borderRadius: 14,
    textAlign: "center",
  },
  achTitle: { fontSize: 10, color: INK, marginTop: 4, lineHeight: 1.2, fontWeight: 700 },
};

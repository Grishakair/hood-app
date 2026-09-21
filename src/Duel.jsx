import { useEffect, useRef, useState } from "react";
import { useAccount, useDisconnect, useSignMessage } from "wagmi";
import { useAppKit } from "@reown/appkit/react";

// Prototype: real 1v1 matchmaking against a WebSocket server
// (server/duelServer.js), still virtual money only. Wallet = login,
// signed nickname, ELO-style rank, achievements, match history, referrals.
// Styled to match the main Hood app (ink/paper/IBM Plex Mono) instead of
// living as a visually separate dark-mode page.
// Temporary public tunnel (SSH reverse tunnel via localhost.run) to the dev
// machine's matchmaking server so this works from the deployed prod site too
// — it dies whenever that tunnel process stops. Set VITE_DUEL_WS_URL to
// override once there's a real always-on host for server/duelServer.js.
// (localtunnel was tried first but shows a browser interstitial page that
// silently breaks the WebSocket handshake — this one doesn't.)
const WS_URL = import.meta.env.VITE_DUEL_WS_URL || "wss://0eed4adead8374.lhr.life";
const ENTRY_AMOUNTS = [10, 25, 50, 75];
const MAX_PICKS = 4;
const ASSETS = [
  "ZEC", "NEAR", "ETH", "AAVE", "BNB", "TRX", "SOL", "XRP",
  "DOGE", "LTC", "ADA", "LINK", "DOT", "AVAX", "SUI", "ARB",
];

const INK = "#0A0A0A";
const GRAY = "#6B6B6B";
const LINE = "#D8D6CE";
const PAPER = "#FDFCF9";
const BLUE = "#3B5BFD"; // player A — never green/red, just "who's who"
const PURPLE = "#8B5CF6"; // player B

const TIER_DOT = {
  Bronze: "#B08968",
  Silver: "#9B9B93",
  Gold: "#C9A227",
  Platinum: "#4FA89B",
  Diamond: BLUE,
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
};

const ERROR_TEXT = {
  not_registered: "Session isn't ready yet — try again.",
  bad_signature: "Signature didn't match — try again.",
  signature_failed: "Couldn't sign the message.",
  pick_at_least_one: "Pick at least one asset.",
  insufficient_balance: "Not enough virtual balance.",
  already_in_a_duel: "You already have an active duel or open lobby.",
  lobby_unavailable: "This lobby is no longer available.",
  cannot_join_own_lobby: "You can't join your own lobby.",
  same_basket: "You can't pick the exact same basket as your opponent.",
  host_no_longer_has_balance: "The host no longer has enough balance — lobby closed.",
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

function sameBasket(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((s, i) => s === sb[i]);
}

function TierBadge({ tier, rating }) {
  return (
    <span style={styles.tierBadge}>
      <span style={{ ...styles.tierDot, background: TIER_DOT[tier] }} />
      {tier} · {rating}
    </span>
  );
}

function VsHeader({ nameA, nameB }) {
  return (
    <div style={styles.vsRow}>
      <div style={styles.vsSide}>
        <div style={{ ...styles.vsAvatar, background: BLUE }}>🕺</div>
        <div style={styles.vsName}>{nameA}</div>
      </div>
      <div style={styles.vsLabel}>VS</div>
      <div style={styles.vsSide}>
        <div style={{ ...styles.vsAvatar, background: PURPLE }}>
          <span style={{ display: "inline-block", transform: "scaleX(-1)" }}>💃</span>
        </div>
        <div style={styles.vsName}>{nameB}</div>
      </div>
    </div>
  );
}

export default function Duel() {
  const { address, isConnected } = useAccount();
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();

  const [wsConnected, setWsConnected] = useState(false);
  const [profile, setProfile] = useState(null);
  const [lobbies, setLobbies] = useState([]);
  const [duel, setDuel] = useState(null);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [toast, setToast] = useState(null);
  const [view, setView] = useState("lobby"); // lobby | profile

  const [nicknameInput, setNicknameInput] = useState("");
  const [signingNickname, setSigningNickname] = useState(false);

  const [createAmount, setCreateAmount] = useState(25);
  const [createPicks, setCreatePicks] = useState(["ZEC"]);
  const [joiningLobby, setJoiningLobby] = useState(null);
  const [joinPicks, setJoinPicks] = useState([]);

  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const incomingRefRef = useRef(new URLSearchParams(window.location.search).get("ref"));
  const refAppliedRef = useRef(false);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!isConnected || !address) return undefined;

    let cancelled = false;

    function connect() {
      const ws = new WebSocket(WS_URL);
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
          setLobbies(msg.lobbies);
        } else if (msg.type === "duel_started") {
          setResult(null);
          setDuel({
            lobbyId: msg.lobbyId,
            entryAmount: msg.entryAmount,
            roundSeconds: msg.roundSeconds,
            players: msg.players,
            timeLeft: msg.roundSeconds,
            pctA: null,
            pctB: null,
            history: [],
          });
          setJoiningLobby(null);
        } else if (msg.type === "tick") {
          setDuel((prev) =>
            prev && prev.lobbyId === msg.lobbyId
              ? { ...prev, timeLeft: msg.timeLeft, pctA: msg.pctA, pctB: msg.pctB, history: msg.history }
              : prev
          );
        } else if (msg.type === "duel_result") {
          setResult({ winner: msg.winner, pctA: msg.pctA, pctB: msg.pctB, entryAmount: msg.entryAmount });
          setProfile(msg.profile);
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

  function createLobby() {
    setErrorMsg("");
    wsSend({ type: "create_lobby", entryAmount: createAmount, picks: createPicks });
  }

  function cancelLobby(lobbyId) {
    wsSend({ type: "cancel_lobby", lobbyId });
  }

  function confirmJoin() {
    if (!joiningLobby) return;
    setErrorMsg("");
    wsSend({ type: "join_lobby", lobbyId: joiningLobby.id, picks: joinPicks });
  }

  function backToLobby() {
    setDuel(null);
    setResult(null);
  }

  const myOpenLobby = lobbies.find((l) => l.hostAddress?.toLowerCase() === address?.toLowerCase());
  const otherLobbies = lobbies.filter((l) => l.hostAddress?.toLowerCase() !== address?.toLowerCase());

  let phase = "connect";
  if (isConnected) {
    if (!wsConnected) phase = "connecting";
    else if (!profile?.nickname) phase = "nickname";
    else if (duel && !result) phase = "round";
    else if (result) phase = "result";
    else phase = "lobby";
  }

  return (
    <div style={styles.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap');
      `}</style>
      <div style={styles.card}>
        {profile?.nickname && (phase === "lobby" || phase === "profile") && (
          <button
            style={styles.profileCorner}
            onClick={() => setView(view === "profile" ? "lobby" : "profile")}
          >
            {view === "profile" ? "🎮 Game" : "👤 Profile"}
          </button>
        )}

        <div style={styles.header}>
          <span style={styles.headerTitle}>🕺 Last Dance</span>
          <span style={styles.headerSub}>whoever's up after 30 seconds takes it all</span>
        </div>

        {profile?.nickname && (
          <div style={styles.topBar}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>
                {profile.nickname} <span style={{ color: GRAY }}>· {shortAddr(address)}</span>
              </span>
              <TierBadge tier={profile.tier} rating={profile.rating} />
            </div>
            <span style={styles.balance}>${profile.balance?.toFixed(2)}</span>
          </div>
        )}

        {toast && <div style={styles.toast}>{toast}</div>}

        {phase === "connect" && (
          <div style={styles.section}>
            <div style={styles.hint}>Connect your wallet to play — it doubles as your login.</div>
            <button style={styles.primaryBtn} onClick={() => open()}>
              [ Connect Wallet ]
            </button>
          </div>
        )}

        {phase === "connecting" && <div style={styles.hint}>Connecting to server…</div>}

        {phase === "nickname" && (
          <div style={styles.section}>
            <div style={styles.label}>Pick a nickname</div>
            <input
              style={styles.input}
              value={nicknameInput}
              onChange={(e) => setNicknameInput(e.target.value)}
              maxLength={20}
              placeholder="Nickname"
            />
            {errorMsg && <div style={styles.error}>{errorMsg}</div>}
            <button style={styles.primaryBtn} onClick={saveNickname} disabled={signingNickname}>
              {signingNickname ? "Sign in your wallet…" : "[ Sign & Save ]"}
            </button>
            <div style={styles.hint}>Signing is free — it proves the address owner set this nickname.</div>
          </div>
        )}

        {phase === "lobby" && view === "lobby" && (
          <LobbyScreen
            balance={profile.balance}
            createAmount={createAmount}
            setCreateAmount={setCreateAmount}
            createPicks={createPicks}
            setCreatePicks={setCreatePicks}
            myOpenLobby={myOpenLobby}
            otherLobbies={otherLobbies}
            onCreate={createLobby}
            onCancel={cancelLobby}
            joiningLobby={joiningLobby}
            setJoiningLobby={setJoiningLobby}
            joinPicks={joinPicks}
            setJoinPicks={setJoinPicks}
            onConfirmJoin={confirmJoin}
            errorMsg={errorMsg}
          />
        )}

        {phase === "lobby" && view === "profile" && <ProfileScreen profile={profile} />}

        {phase === "round" && duel && <RoundScreen duel={duel} myAddress={address} />}

        {phase === "result" && result && duel && (
          <ResultScreen duel={duel} result={result} myAddress={address} onBack={backToLobby} />
        )}

        {profile?.nickname && (
          <button style={styles.disconnectBtn} onClick={() => disconnect()}>
            disconnect wallet
          </button>
        )}
      </div>
    </div>
  );
}

function AssetPicker({ picks, onChange, accent }) {
  function toggle(symbol) {
    if (picks.includes(symbol)) onChange(picks.filter((s) => s !== symbol));
    else if (picks.length < MAX_PICKS) onChange([...picks, symbol]);
  }
  return (
    <div style={styles.assetGrid}>
      {ASSETS.map((a) => {
        const active = picks.includes(a);
        const disabled = !active && picks.length >= MAX_PICKS;
        return (
          <button
            key={a}
            onClick={() => toggle(a)}
            disabled={disabled}
            style={{
              ...styles.assetChip,
              ...(active ? { background: accent, color: PAPER, borderColor: accent, fontWeight: 600 } : {}),
              ...(disabled ? { opacity: 0.35, cursor: "default" } : {}),
            }}
          >
            {a}
          </button>
        );
      })}
    </div>
  );
}

function LobbyScreen({
  balance,
  createAmount,
  setCreateAmount,
  createPicks,
  setCreatePicks,
  myOpenLobby,
  otherLobbies,
  onCreate,
  onCancel,
  joiningLobby,
  setJoiningLobby,
  joinPicks,
  setJoinPicks,
  onConfirmJoin,
  errorMsg,
}) {
  if (joiningLobby) {
    const blocked = joinPicks.length > 0 && sameBasket(joinPicks, joiningLobby.hostPicks);
    return (
      <div style={styles.section}>
        <div style={styles.label}>
          Playing against {joiningLobby.hostNickname} · stake ${joiningLobby.entryAmount}
        </div>
        <div style={styles.hint}>Opponent picked: {joiningLobby.hostPicks.join(", ")}</div>
        <div style={{ ...styles.label, marginTop: 12 }}>Pick your coin basket</div>
        <div style={styles.hint}>Pick up to {MAX_PICKS} coins — your stake splits evenly between them.</div>
        <AssetPicker picks={joinPicks} onChange={setJoinPicks} accent={PURPLE} />
        {blocked && <div style={styles.error}>You can't pick the exact same set as your opponent.</div>}
        {errorMsg && <div style={styles.error}>{errorMsg}</div>}
        <button
          style={styles.primaryBtn}
          disabled={joinPicks.length === 0 || blocked}
          onClick={onConfirmJoin}
        >
          [ Start Duel ]
        </button>
        <button style={styles.secondaryBtn} onClick={() => setJoiningLobby(null)}>
          back
        </button>
      </div>
    );
  }

  if (myOpenLobby) {
    return (
      <div style={styles.section}>
        <div style={styles.resultBanner}>Waiting for an opponent… stake ${myOpenLobby.entryAmount}</div>
        <div style={styles.hint}>Your basket: {myOpenLobby.hostPicks.join(", ")}</div>
        <button style={styles.secondaryBtn} onClick={() => onCancel(myOpenLobby.id)}>
          cancel
        </button>
      </div>
    );
  }

  return (
    <div style={styles.section}>
      <div style={styles.label}>Open games right now</div>
      {otherLobbies.length === 0 && <div style={styles.hint}>No one yet — be the first.</div>}
      {otherLobbies.map((l) => (
        <div key={l.id} style={styles.lobbyRow}>
          <div>
            <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
              {l.hostNickname}
              <TierBadge tier={l.hostTier} rating={l.hostRating} />
            </div>
            <div style={styles.rowSub}>
              ${l.entryAmount} · {l.hostPicks.join(", ")}
            </div>
          </div>
          <button
            style={styles.joinBtn}
            disabled={balance < l.entryAmount}
            onClick={() => {
              setJoiningLobby(l);
              setJoinPicks([]);
            }}
          >
            play
          </button>
        </div>
      ))}

      <div style={{ ...styles.label, marginTop: 20 }}>Or start your own game</div>
      <div style={styles.chipRow}>
        {ENTRY_AMOUNTS.map((amt) => (
          <button
            key={amt}
            onClick={() => setCreateAmount(amt)}
            disabled={balance < amt}
            style={{
              ...styles.chip,
              ...(createAmount === amt ? styles.chipActive : {}),
              ...(balance < amt ? { opacity: 0.35 } : {}),
            }}
          >
            ${amt}
          </button>
        ))}
      </div>
      <div style={styles.hint}>Pick up to {MAX_PICKS} coins — your stake splits evenly between them.</div>
      <AssetPicker picks={createPicks} onChange={setCreatePicks} accent={BLUE} />
      {errorMsg && <div style={styles.error}>{errorMsg}</div>}
      <button style={styles.primaryBtn} disabled={createPicks.length === 0 || balance < createAmount} onClick={onCreate}>
        [ Create Game ]
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
          <div style={{ fontWeight: 600 }}>{profile.referralCode}</div>
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
            <div style={{ fontWeight: 600 }}>
              {h.result === "win" ? "Win" : h.result === "loss" ? "Loss" : "Tie"} vs {h.opponentNickname}
            </div>
            <div style={styles.rowSub}>
              ${h.entryAmount} · {formatPct(h.pct)} vs {formatPct(h.oppPct)}
            </div>
          </div>
          <div style={{ color: INK, fontWeight: 600 }}>
            {h.ratingDelta >= 0 ? "+" : ""}
            {h.ratingDelta}
          </div>
        </div>
      ))}
    </div>
  );
}

function PctChart({ history, roundSeconds }) {
  const W = 400;
  const H = 140;
  const PAD = 8;
  const valsA = history.map((h) => h.pctA).filter((v) => v != null);
  const valsB = history.map((h) => h.pctB).filter((v) => v != null);
  const all = [...valsA, ...valsB, 0];
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

  const lineA = history.filter((h) => h.pctA != null).map((h) => `${xFor(h.t)},${yFor(h.pctA)}`).join(" ");
  const lineB = history.filter((h) => h.pctB != null).map((h) => `${xFor(h.t)},${yFor(h.pctB)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 140, display: "block" }}>
      <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke={LINE} strokeDasharray="4 4" />
      {lineB && <polyline points={lineB} fill="none" stroke={PURPLE} strokeWidth="3" />}
      {lineA && <polyline points={lineA} fill="none" stroke={BLUE} strokeWidth="3" />}
    </svg>
  );
}

function RoundScreen({ duel, myAddress }) {
  const { players, timeLeft, pctA, pctB, entryAmount, history, roundSeconds } = duel;
  const iAmA = players.A.address.toLowerCase() === myAddress?.toLowerCase();
  return (
    <div style={styles.section}>
      <VsHeader
        nameA={`${players.A.nickname}${iAmA ? " (you)" : ""}`}
        nameB={`${players.B.nickname}${!iAmA ? " (you)" : ""}`}
      />
      <div style={styles.timer}>{formatClock(timeLeft)}</div>
      <PctChart history={history} roundSeconds={roundSeconds} />
      <PlayerCard
        label="A"
        picks={players.A.picks}
        tier={players.A.tier}
        rating={players.A.rating}
        accent={BLUE}
        pct={pctA}
        pnl={entryAmount * ((pctA ?? 0) / 100)}
        leading={pctA != null && pctB != null && pctA >= pctB}
      />
      <PlayerCard
        label="B"
        picks={players.B.picks}
        tier={players.B.tier}
        rating={players.B.rating}
        accent={PURPLE}
        pct={pctB}
        pnl={entryAmount * ((pctB ?? 0) / 100)}
        leading={pctA != null && pctB != null && pctB > pctA}
      />
    </div>
  );
}

function PlayerCard({ label, picks, tier, rating, accent, pct, pnl, leading }) {
  return (
    <div style={{ ...styles.card2, borderColor: leading ? accent : LINE }}>
      <div style={styles.card2Header}>
        <div>
          <div style={{ ...styles.rowLabel, color: accent }}>
            {label} {leading && "👑"}
          </div>
          {tier && <TierBadge tier={tier} rating={rating} />}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ ...styles.pct, color: accent }}>{formatPct(pct)}</div>
          <div style={styles.rowSub}>{formatUsd(pnl)}</div>
        </div>
      </div>
      <div style={styles.rowSub}>{picks.join(", ")}</div>
    </div>
  );
}

function ResultScreen({ duel, result, myAddress, onBack }) {
  const { players, entryAmount, history, roundSeconds } = duel;
  const { winner, pctA, pctB } = result;
  const iAmA = players.A.address.toLowerCase() === myAddress?.toLowerCase();
  const iWon = (winner === "A" && iAmA) || (winner === "B" && !iAmA);
  const pot = entryAmount * 2;
  return (
    <div style={styles.section}>
      <VsHeader
        nameA={`${players.A.nickname}${iAmA ? " (you)" : ""}`}
        nameB={`${players.B.nickname}${!iAmA ? " (you)" : ""}`}
      />
      {winner === "tie" ? (
        <div style={styles.resultBanner}>Tie — stakes returned</div>
      ) : (
        <div style={styles.resultBanner}>
          {iWon ? `You won $${pot.toFixed(2)}` : `You lost $${entryAmount.toFixed(2)}`}
        </div>
      )}
      <PctChart history={history} roundSeconds={roundSeconds} />
      <PlayerCard
        label="A"
        picks={players.A.picks}
        tier={players.A.tier}
        rating={players.A.rating}
        accent={BLUE}
        pct={pctA}
        pnl={entryAmount * (pctA / 100)}
        leading={winner === "A"}
      />
      <PlayerCard
        label="B"
        picks={players.B.picks}
        tier={players.B.tier}
        rating={players.B.rating}
        accent={PURPLE}
        pct={pctB}
        pnl={entryAmount * (pctB / 100)}
        leading={winner === "B"}
      />
      <button style={styles.primaryBtn} onClick={onBack}>
        [ Back to Lobby ]
      </button>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: PAPER,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "'IBM Plex Mono', monospace",
    color: INK,
    padding: 20,
  },
  card: {
    position: "relative",
    width: 440,
    maxWidth: "100%",
    background: PAPER,
    border: `1px solid ${INK}`,
    padding: 24,
  },
  profileCorner: {
    position: "absolute",
    top: 16,
    right: 16,
    padding: "4px 10px",
    border: `1px solid ${LINE}`,
    background: "transparent",
    color: GRAY,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 11,
  },
  header: { marginBottom: 16, textAlign: "center" },
  headerTitle: { display: "block", fontSize: 22, fontWeight: 600, color: INK },
  headerSub: { display: "block", fontSize: 12, color: GRAY, marginTop: 4 },
  topBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 13,
    color: INK,
    padding: "10px 14px",
    border: `1px solid ${LINE}`,
    marginBottom: 12,
  },
  balance: { color: INK, fontWeight: 600 },
  tierBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11,
    fontWeight: 600,
    border: `1px solid ${LINE}`,
    padding: "2px 6px",
    width: "fit-content",
    color: GRAY,
  },
  tierDot: { width: 6, height: 6, borderRadius: "50%", display: "inline-block" },
  toast: {
    background: PAPER,
    border: `1px solid ${INK}`,
    color: INK,
    fontSize: 12,
    padding: "8px 12px",
    marginBottom: 12,
    textAlign: "center",
  },
  section: { display: "flex", flexDirection: "column" },
  label: { fontSize: 13, color: GRAY, marginBottom: 8 },
  chipRow: { display: "flex", gap: 8, marginBottom: 12 },
  chip: {
    flex: 1,
    padding: "10px 0",
    border: `1px solid ${LINE}`,
    background: "transparent",
    color: INK,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 14,
  },
  chipActive: { background: INK, color: PAPER, borderColor: INK },
  assetGrid: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 16 },
  assetChip: {
    padding: "8px 0",
    border: `1px solid ${LINE}`,
    background: "transparent",
    color: INK,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 12,
  },
  input: {
    width: "100%",
    padding: "12px 14px",
    border: `1px solid ${LINE}`,
    background: "transparent",
    color: INK,
    fontFamily: "inherit",
    fontSize: 14,
    marginBottom: 12,
  },
  primaryBtn: {
    marginTop: 8,
    padding: "14px 0",
    border: `1px solid ${INK}`,
    background: INK,
    color: PAPER,
    fontFamily: "inherit",
    fontSize: 14,
    cursor: "pointer",
  },
  secondaryBtn: {
    marginTop: 10,
    padding: "12px 0",
    border: `1px solid ${LINE}`,
    background: "transparent",
    color: INK,
    fontFamily: "inherit",
    fontSize: 13,
    cursor: "pointer",
  },
  disconnectBtn: {
    marginTop: 16,
    padding: "8px 0",
    border: "none",
    background: "transparent",
    color: GRAY,
    fontFamily: "inherit",
    fontSize: 12,
    cursor: "pointer",
    textDecoration: "underline",
  },
  hint: { marginTop: 8, marginBottom: 8, fontSize: 12, color: GRAY, textAlign: "center" },
  error: { color: "#B3261E", fontSize: 13, marginBottom: 12 },
  vsRow: { display: "flex", alignItems: "center", justifyContent: "center", gap: 16, marginBottom: 12 },
  vsSide: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6, width: 110 },
  vsAvatar: {
    width: 56,
    height: 56,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 26,
    border: `1px solid ${INK}`,
  },
  vsName: { fontSize: 12, color: INK, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 110 },
  vsLabel: { fontSize: 13, color: GRAY, fontWeight: 600 },
  timer: {
    textAlign: "center",
    fontSize: 38,
    fontWeight: 600,
    color: INK,
    marginBottom: 12,
    fontVariantNumeric: "tabular-nums",
  },
  lobbyRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 14px",
    border: `1px solid ${LINE}`,
    marginBottom: 10,
  },
  rowSub: { fontSize: 12, color: GRAY },
  joinBtn: {
    padding: "8px 16px",
    border: `1px solid ${INK}`,
    background: "transparent",
    color: INK,
    fontFamily: "inherit",
    fontSize: 13,
    cursor: "pointer",
  },
  card2: {
    padding: "14px 16px",
    border: `1px solid ${LINE}`,
    marginBottom: 12,
  },
  card2Header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 6,
  },
  rowLabel: { fontSize: 14, fontWeight: 600 },
  pct: { fontSize: 18, fontWeight: 600 },
  resultBanner: {
    textAlign: "center",
    fontSize: 15,
    fontWeight: 600,
    color: INK,
    border: `1px solid ${INK}`,
    padding: "14px 12px",
    marginBottom: 16,
  },
  statsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  statBox: {
    padding: "12px 14px",
    border: `1px solid ${LINE}`,
    textAlign: "center",
  },
  statValue: { fontSize: 20, fontWeight: 600, color: INK },
  achGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 },
  achCard: {
    padding: "10px 6px",
    border: `1px solid ${LINE}`,
    textAlign: "center",
  },
  achTitle: { fontSize: 10, color: INK, marginTop: 4, lineHeight: 1.2 },
};

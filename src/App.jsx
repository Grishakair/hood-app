import { useState, useEffect, useRef } from "react";
import { useAccount, useBalance, useChainId, useDisconnect } from "wagmi";
import {
  getBalance,
  multicall,
  sendTransaction,
  writeContract,
  waitForTransactionReceipt,
} from "wagmi/actions";
import { formatUnits } from "viem";
import QRCode from "qrcode";
import { useAppKit } from "@reown/appkit/react";
import { mainnet, base, optimism, polygon, bsc } from "@reown/appkit/networks";
import { wagmiConfig } from "./config/appkit.js";
import BorrowPanel from "./Borrow.jsx";
import {
  EXPLORER_BY_CHAIN,
  CHAIN_ID_BY_NETWORK,
  NATIVE_SYMBOL_BY_CHAIN,
  CHAIN_NAME_BY_ID,
  ensureChain,
  truncateDecimalString,
  AURORA_QUOTE_URL,
  AURORA_DEPOSIT_SUBMIT_URL,
  AURORA_STATUS_URL,
  toBaseUnits,
  findTokenRecord,
  STATUS_DETAIL_LABEL,
  buildQuoteBody,
  fetchQuoteWithRetry,
  quoteErrorMessage,
  ERC20_ABI,
} from "./lib/shared.js";

// Fallback token metadata for the picker when the live 1click list can't be
// fetched. No balances here — real balances only ever come from the
// connected wallet (see TokenBalance below).
const TOKEN_LIST = [
  { symbol: "ETH", network: "Ethereum" },
  { symbol: "ETH", network: "Base" },
  { symbol: "ETH", network: "Optimism" },
  { symbol: "USDC", network: "Base" },
  { symbol: "USDC", network: "Ethereum" },
  { symbol: "NEAR", network: "NEAR" },
  { symbol: "POL", network: "Polygon" },
  { symbol: "BTC", network: "Bitcoin" },
];

const NETWORK_CHIPS = ["all", "ethereum", "base", "optimism", "polygon", "near", "bitcoin"];

// Shown first in the network filter chips — our highest-priority chains.
// Tron was tried here too, but real (non-dry) quotes for it fail 100% of
// the time on Aurora's side right now (verified with 20+ requests across
// pairs/amounts/directions — dry-preview rate estimates work fine, only
// actual deposit-address generation is broken) — not something we can fix
// on our end, so it stays demoted under "more" until that's resolved,
// rather than featuring a route that can't currently complete.
const SUPPORTED_NETWORK_CODES = ["eth", "base", "bsc", "pol"];

// Sort order for the buy/receive token list — the 1click API returns NEAR
// tokens first just because of how it's indexed, not because they're most
// relevant. This pushes well-known tokens on well-known chains to the top
// instead, in a specific hand-picked order, then "popular symbol on popular
// chain" generally, leaving everything else exactly where it already was.
const PRIORITY_TOKEN_ORDER = [
  { symbol: "USDC", network: "eth" },
  { symbol: "USDC", network: "base" },
  { symbol: "USDT", network: "eth" },
  { symbol: "USDT", network: "base" },
  { symbol: "ETH", network: "eth" },
  { symbol: "ZEC", network: "zec" },
];
const POPULAR_TOKEN_SYMBOLS = ["USDC", "USDT", "ETH", "WETH", "POL", "BTC", "SOL", "BNB"];
const POPULAR_TOKEN_NETWORKS = ["eth", "base", "bsc", "pol"];

function tokenSortRank(t) {
  const net = t.network?.toLowerCase();
  const exactIdx = PRIORITY_TOKEN_ORDER.findIndex((p) => p.symbol === t.symbol && p.network === net);
  if (exactIdx !== -1) return exactIdx;
  if (POPULAR_TOKEN_SYMBOLS.includes(t.symbol) && POPULAR_TOKEN_NETWORKS.includes(net)) return 100;
  return 1000;
}

// "max" on a native token must leave room for gas — a conservative fixed
// buffer rather than a live estimate, in the token's own units.
const GAS_RESERVE_NATIVE = {
  [mainnet.id]: 0.002,
  [base.id]: 0.0005,
  [optimism.id]: 0.0005,
  [polygon.id]: 0.05,
  [bsc.id]: 0.001,
};

const isEvmAddress = (value) => /^0x[a-fA-F0-9]{40}$/.test(value || "");
const isTronAddress = (value) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value || "");
const isSolanaAddress = (value) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value || "");
const isNearAddress = (value) =>
  /^(?=.{2,64}$)[a-z0-9_-]+(\.[a-z0-9_-]+)*\.(near|testnet)$/.test(value || "") || /^[0-9a-f]{64}$/.test(value || "");
const isBitcoinAddress = (value) =>
  /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(value || "") || /^(bc1)[a-z0-9]{25,60}$/i.test(value || "");
const isXrpAddress = (value) => /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(value || "");

const ADDRESS_VALIDATOR_BY_NETWORK = {
  tron: isTronAddress,
  sol: isSolanaAddress,
  near: isNearAddress,
  btc: isBitcoinAddress,
  xrp: isXrpAddress,
};

// Catches the most common (and most costly) mistake — pasting an address
// in the wrong chain's format, e.g. an 0x address as a Solana or Tron
// recipient. Has real format checks for the chains people actually use
// most; for the rest of the 30+ chains we can't validate the exact
// format, but an EVM-shaped address is never right for a non-EVM chain
// either way, so that alone is always worth catching.
function addressLooksWrongForChain(value, network) {
  const net = network?.toLowerCase();
  if (!value) return false;
  const validator = ADDRESS_VALIDATOR_BY_NETWORK[net];
  if (validator) return !validator(value);
  if (CHAIN_ID_BY_NETWORK[net]) return !isEvmAddress(value);
  return isEvmAddress(value);
}

// Buy/receive pickers always show price — never a wallet balance. Only the
// sell picker cares what you hold (see the batched fetch in App below).
function TokenBalance({ token, gray }) {
  if (token.price !== undefined) {
    return <div style={{ fontSize: 13 }}>${token.price < 1 ? token.price.toFixed(4) : token.price.toFixed(2)}</div>;
  }

  return <div style={{ fontSize: 13, color: gray }}>—</div>;
}

// One multicall per chain instead of one RPC call per token — with 50+
// candidate tokens across 4 chains, per-token requests get rate-limited by
// the public RPC and silently look like "you own nothing".
async function fetchOwnedBalances(tokens, address) {
  const byChain = new Map();
  tokens.forEach((t) => {
    const chainId = CHAIN_ID_BY_NETWORK[t.network?.toLowerCase()];
    if (!chainId) return;
    if (!byChain.has(chainId)) byChain.set(chainId, []);
    byChain.get(chainId).push(t);
  });

  const results = {};

  await Promise.all(
    Array.from(byChain.entries()).map(async ([chainId, chainTokens]) => {
      const nativeSymbol = NATIVE_SYMBOL_BY_CHAIN[chainId];
      const nativeTokens = chainTokens.filter((t) => t.symbol === nativeSymbol);
      const erc20Tokens = chainTokens.filter((t) => t.symbol !== nativeSymbol && isEvmAddress(t.contractAddress));

      if (nativeTokens.length) {
        try {
          const balance = await getBalance(wagmiConfig, { address, chainId });
          nativeTokens.forEach((t) => {
            results[`${t.symbol}|${t.network}`] = balance.value;
          });
        } catch {
          // ignore — treated as "not held"
        }
      }

      if (erc20Tokens.length) {
        try {
          const calls = await multicall(wagmiConfig, {
            chainId,
            contracts: erc20Tokens.map((t) => ({
              address: t.contractAddress,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [address],
            })),
          });
          erc20Tokens.forEach((t, i) => {
            if (calls[i]?.status === "success") {
              results[`${t.symbol}|${t.network}`] = calls[i].result;
            }
          });
        } catch {
          // ignore — treated as "not held"
        }
      }
    })
  );

  return results;
}

function HoodMark({ size = 22, ink, paper }) {
  return (
    <svg width={size} height={size} viewBox="0 0 160 160" style={{ display: "block" }}>
      <path
        d="M 80 12 C 42 12 18 36 18 68 L 18 108 C 18 126 28 138 48 140 L 112 140 C 132 138 142 126 142 108 L 142 68 C 142 36 118 12 80 12 Z"
        fill={ink}
      />
      <circle cx="55" cy="78" r="16" fill={paper} />
      <circle cx="105" cy="78" r="16" fill={paper} />
    </svg>
  );
}

// Small line-art icons for the "how it works" illustrations — same
// monochrome ink/paper duotone as HoodMark, kept intentionally simple.
function CoinIcon({ ink, paper, size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40">
      <circle cx="20" cy="20" r="17" fill={ink} />
      <circle cx="20" cy="20" r="11" fill="none" stroke={paper} strokeWidth="1.6" strokeDasharray="3 3" />
    </svg>
  );
}

function WalletIcon({ ink, paper, size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40">
      <rect x="4" y="10" width="32" height="22" rx="3" fill="none" stroke={ink} strokeWidth="2.4" />
      <rect x="23" y="17.5" width="13" height="8" rx="1.6" fill={ink} />
      <circle cx="29.5" cy="21.5" r="1.6" fill={paper} />
    </svg>
  );
}

function ChainIcon({ ink, size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40">
      <circle cx="10" cy="12" r="5" fill="none" stroke={ink} strokeWidth="2.4" />
      <circle cx="30" cy="12" r="5" fill="none" stroke={ink} strokeWidth="2.4" />
      <circle cx="20" cy="30" r="5" fill="none" stroke={ink} strokeWidth="2.4" />
      <line x1="14.5" y1="14" x2="25.5" y2="14" stroke={ink} strokeWidth="1.8" />
      <line x1="12" y1="16.5" x2="18" y2="26" stroke={ink} strokeWidth="1.8" />
      <line x1="28" y1="16.5" x2="22" y2="26" stroke={ink} strokeWidth="1.8" />
    </svg>
  );
}

function LockIcon({ ink, size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40">
      <rect x="9" y="18" width="22" height="16" rx="2.4" fill="none" stroke={ink} strokeWidth="2.4" />
      <path d="M14 18v-4a6 6 0 0 1 12 0v4" fill="none" stroke={ink} strokeWidth="2.4" />
      <circle cx="20" cy="26" r="2" fill={ink} />
    </svg>
  );
}

const HOW_ICONS = { coin: CoinIcon, wallet: WalletIcon, chain: ChainIcon, lock: LockIcon };

const HOW_LEVELS = [
  {
    key: 1,
    label: "explain like I'm 7",
    icons: ["coin", "hood", "coin"],
    captions: ["apple", "hood", "candy"],
    paragraphs: [
      "Hood is a magic box.",
      "You put in an apple. You take out candy. And here's the trick: nobody watching ever finds out you made that swap.",
      "You can also just hand someone an apple — like passing a secret note. The person who gets it will never know it came from you.",
    ],
  },
  {
    key: 2,
    label: "I know the basics",
    icons: ["wallet", "hood", "chain"],
    captions: ["your wallet", "hood", "any chain"],
    paragraphs: [
      "Hood doesn't execute your trade itself — it turns your request into an intent: what you have, what you want, where it should end up.",
      "A network of solvers then competes to fill that intent at the best price. You're not picking a route through some pool — they bid, the best quote wins, and a smart contract enforces the deal: it either settles fully, or you get automatically refunded.",
      "That's also how it moves value across chains without a separate \"bridge\" step — the solver network just settles the intent wherever your destination chain is.",
      "Turn on \"private\" and the whole thing settles through Confidential Intents on NEAR instead of the public rails. The swap or transfer never shows up tied to your address on a public explorer, and the recipient can't see who sent it or what the original token was.",
    ],
  },
  {
    key: 3,
    label: "crypto OG",
    icons: ["wallet", "chain", "lock"],
    captions: ["intent", "solver network", "confidential intents"],
    paragraphs: [
      "Hood is a thin client over NEAR's intents settlement layer. You're not routing through liquidity yourself — you emit a declarative intent (source asset, destination asset, delivery address) and a competitive market of solvers bids for the right to fill it.",
      "Settlement is atomic: the winning quote is enforced by contract logic on NEAR, so the intent either fills completely or reverts with a refund — no partial fills, no bridge custody window in between.",
      "Cross-chain is a side effect of that design, not a bolted-on feature. Solvers compete across venues and chains, so moving value into a different asset on a different chain looks, protocol-wise, identical to a same-chain fill.",
      "Confidential mode moves settlement onto NEAR's shielded intents rails instead of the public path. The fill still happens on-chain, but the depositor-to-recipient linkage is broken at the settlement layer itself, not just hidden in a UI.",
    ],
  },
];

// Deterministic pseudo-random in [0,1) — same trick as the balance/quote
// helpers, kept local since it's only used for the ASCII illustration below.
function asciiPseudoRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

const HOOD_ASCII_LIGHT = [".", ":", "'", ","];
const HOOD_ASCII_MID = ["i", "r", "v", "x", "u", "n", "c", "l"];
const HOOD_ASCII_HEAVY = ["B", "Q", "R", "8", "M", "W", "%", "#", "D"];

// Point-in-rounded-rect test — a cheap stand-in for the real HoodMark bezier
// path, good enough for a stylized character-art rendering.
function insideRoundedRect(px, py, x0, y0, x1, y1, r) {
  const nx = Math.min(Math.max(px, x0 + r), x1 - r);
  const ny = Math.min(Math.max(py, y0 + r), y1 - r);
  if (px >= x0 + r && px <= x1 - r && py >= y0 && py <= y1) return true;
  if (py >= y0 + r && py <= y1 - r && px >= x0 && px <= x1) return true;
  const dx = px - nx;
  const dy = py - ny;
  return dx * dx + dy * dy <= r * r;
}

function hoodEdgeDepth(px, py, x0, y0, x1, y1, r) {
  const d = Math.min(py - y0, y1 - py, px - x0, x1 - px, r);
  return Math.max(0, d) / r;
}

// Built once at module load (not per-render) — a grid of characters shaded
// densest at the center and lightest near the silhouette's edge, with the
// two eye-holes punched out, matching HoodMark's shape.
const HOOD_ASCII_ROWS = (() => {
  const cols = 84;
  const rows = 50;
  const x0 = 6,
    y0 = 10,
    x1 = 154,
    y1 = 150,
    r = 46;
  const eyeR = 15;
  const eyeLX = 58,
    eyeLY = 76;
  const eyeRX = 102,
    eyeRY = 76;
  const out = [];
  for (let row = 0; row < rows; row++) {
    let line = "";
    for (let col = 0; col < cols; col++) {
      const px = (col / (cols - 1)) * 160;
      const py = (row / (rows - 1)) * 178;
      const dEyeL = Math.hypot(px - eyeLX, py - eyeLY);
      const dEyeR = Math.hypot(px - eyeRX, py - eyeRY);
      const inside = insideRoundedRect(px, py, x0, y0, x1, y1, r) && dEyeL > eyeR && dEyeR > eyeR;
      if (!inside) {
        line += " ";
        continue;
      }
      const depth = hoodEdgeDepth(px, py, x0, y0, x1, y1, r);
      const rnd = asciiPseudoRandom(row * 1000 + col);
      const set = depth < 0.12 ? HOOD_ASCII_LIGHT : depth < 0.4 ? HOOD_ASCII_MID : HOOD_ASCII_HEAVY;
      line += set[Math.floor(rnd * set.length)];
    }
    out.push(line);
  }
  return out;
})();

// Used as a small centered footer flourish on the Hood club page — the
// floating full-size version (bleeding off the right edge) didn't sit well
// next to the rest of the UI's very sparse style, so it's retired to this
// one, deliberate spot instead.
function HoodAsciiArt({ ink }) {
  return (
    <pre
      style={{
        display: "inline-block",
        margin: 0,
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 6,
        lineHeight: "6px",
        color: ink,
        opacity: 0.6,
        userSelect: "none",
      }}
    >
      {HOOD_ASCII_ROWS.join("\n")}
    </pre>
  );
}

function HowItWorks({ ink, gray, line, paper, howLevel, setHowLevel }) {
  const level = HOW_LEVELS.find((l) => l.key === howLevel) || HOW_LEVELS[0];

  return (
    <div style={{ maxWidth: 420, margin: "0 auto" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginBottom: 20 }}>
        {HOW_LEVELS.map((l) => (
          <span
            key={l.key}
            onClick={() => setHowLevel(l.key)}
            style={{
              fontSize: 12,
              padding: "6px 10px",
              border: `1px solid ${ink}`,
              cursor: "pointer",
              background: howLevel === l.key ? ink : "transparent",
              color: howLevel === l.key ? paper : ink,
            }}
          >
            [ {l.label} ]
          </span>
        ))}
      </div>

      <div style={{ border: `1px solid ${ink}`, background: paper, padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 18, marginBottom: 22 }}>
          {level.icons.map((iconKey, i) => {
            const Icon = iconKey === "hood" ? null : HOW_ICONS[iconKey];
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 18 }}>
                <div style={{ textAlign: "center" }}>
                  {iconKey === "hood" ? <HoodMark size={26} ink={ink} paper={paper} /> : <Icon ink={ink} paper={paper} />}
                  <div style={{ fontSize: 10, color: gray, marginTop: 6, whiteSpace: "nowrap" }}>{level.captions[i]}</div>
                </div>
                {i < level.icons.length - 1 && <div style={{ fontSize: 14, color: gray }}>→</div>}
              </div>
            );
          })}
        </div>

        {level.paragraphs.map((p, i) => (
          <p key={i} style={{ fontSize: 13, lineHeight: 1.6, margin: i === 0 ? 0 : "12px 0 0" }}>
            {p}
          </p>
        ))}
      </div>
    </div>
  );
}

function WalletMenu({ address, ink, gray, line, paper, onClose }) {
  const chainId = useChainId();
  const { disconnect } = useDisconnect();
  const { data: balance } = useBalance({ address, chainId: mainnet.id });
  const [copied, setCopied] = useState(false);

  const explorerBase = EXPLORER_BY_CHAIN[chainId] || EXPLORER_BY_CHAIN[mainnet.id];

  const copyAddress = () => {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const rowStyle = {
    padding: "10px 16px",
    fontSize: 12,
    cursor: "pointer",
    borderTop: `1px solid ${line}`,
  };

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 25 }} onClick={onClose} />
      <div
        style={{
          position: "absolute",
          top: "calc(100% + 8px)",
          right: 0,
          width: 250,
          border: `1px solid ${ink}`,
          background: paper,
          zIndex: 26,
        }}
      >
        <div style={{ padding: "20px 16px", textAlign: "center", borderBottom: `1px solid ${line}` }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
            <HoodMark size={34} ink={ink} paper={paper} />
          </div>
          <div style={{ fontSize: 13 }}>
            {address.slice(0, 6)}…{address.slice(-4)}
          </div>
          <div style={{ fontSize: 11, color: gray, marginTop: 4 }}>
            {balance && Number.isFinite(Number(balance.formatted)) ? `${Number(balance.formatted).toFixed(4)} ETH` : "..."}
          </div>
          <div
            style={{
              display: "inline-block",
              marginTop: 10,
              fontSize: 10,
              letterSpacing: 1,
              border: `1px solid ${ink}`,
              padding: "3px 8px",
            }}
          >
            [ hood level 1 ]
          </div>
        </div>

        <div onClick={copyAddress} style={rowStyle}>
          {copied ? "[ copied ]" : "[ copy address ]"}
        </div>
        <div
          onClick={() => window.open(`${explorerBase}/address/${address}`, "_blank", "noopener,noreferrer")}
          style={rowStyle}
        >
          [ view on explorer ]
        </div>
        <div
          onClick={() => {
            disconnect();
            onClose();
          }}
          style={{ ...rowStyle, color: "#B3261E" }}
        >
          [ disconnect ]
        </div>
      </div>
    </>
  );
}

export default function App() {
  const { open } = useAppKit();
  const { address, isConnected } = useAccount();
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);

  const [topTab, setTopTab] = useState("app"); // app | how | club
  const [howLevel, setHowLevel] = useState(1);
  const [mode, setMode] = useState("swap");
  const [priv, setPriv] = useState(false);
  const [sellAmt, setSellAmt] = useState("");
  const [sellTok, setSellTok] = useState("ETH");
  const [sellNetwork, setSellNetwork] = useState("eth");
  const [buyTok, setBuyTok] = useState(null);
  const [buyNetwork, setBuyNetwork] = useState(null);
  const [buyAmount, setBuyAmount] = useState("");
  const [quoteStatus, setQuoteStatus] = useState("idle"); // idle | loading | ok | error
  const [swapFeeBps, setSwapFeeBps] = useState(null);
  const [swapStatus, setSwapStatus] = useState("idle"); // idle | quoting | awaiting-signature | pending-deposit | awaiting-deposit | processing | success | failed | refunded | error
  const [swapError, setSwapError] = useState("");
  const [swapTxHash, setSwapTxHash] = useState("");
  // Unlike swapTxHash (cleared whenever the trade form changes), this is a
  // persistent receipt of the last broadcast deposit — kept around so it
  // doesn't vanish the moment you start setting up the next swap.
  const [lastTxHash, setLastTxHash] = useState("");
  const [lastTxChainId, setLastTxChainId] = useState(null);
  const [swapStatusDetail, setSwapStatusDetail] = useState("");
  const swapPollToken = useRef(0);
  // Manual-deposit mode: no connected wallet signs anything — we just hand
  // back a one-time deposit address and watch for the funds to arrive, same
  // as any exchange-style deposit flow. Lets non-EVM origins (Tron, BTC,
  // SOL, ...) and "I'd rather not connect a wallet" both work.
  const [swapManualOverride, setSwapManualOverride] = useState(false);
  const [swapRefundAddress, setSwapRefundAddress] = useState("");
  const [swapDepositAddress, setSwapDepositAddress] = useState("");
  const [swapDepositDeadline, setSwapDepositDeadline] = useState(null);
  const [swapDepositTimeEstimate, setSwapDepositTimeEstimate] = useState(null);
  const [recipient, setRecipient] = useState("");
  const [sendAmt, setSendAmt] = useState("");
  const [sendTok, setSendTok] = useState("ETH");
  const [sendNetwork, setSendNetwork] = useState("eth");
  const [sendStatus, setSendStatus] = useState("idle"); // idle | quoting | awaiting-signature | pending-deposit | awaiting-deposit | processing | success | failed | refunded | error
  const [sendError, setSendError] = useState("");
  const [sendTxHash, setSendTxHash] = useState("");
  const [sendStatusDetail, setSendStatusDetail] = useState("");
  const sendPollToken = useRef(0);
  const [sendManualOverride, setSendManualOverride] = useState(false);
  const [sendRefundAddress, setSendRefundAddress] = useState("");
  const [sendDepositAddress, setSendDepositAddress] = useState("");
  const [sendDepositDeadline, setSendDepositDeadline] = useState(null);
  const [sendDepositTimeEstimate, setSendDepositTimeEstimate] = useState(null);
  const [swapRecipient, setSwapRecipient] = useState("");
  const [swapPriv, setSwapPriv] = useState(false);
  const [slippage, setSlippage] = useState("0.5");
  const [customSlippage, setCustomSlippage] = useState("");
  const [showSlippage, setShowSlippage] = useState(false);
  const [showMoreSettings, setShowMoreSettings] = useState(false);
  const slippagePresets = ["0.1", "0.5", "1.0"];

  const [showError, setShowError] = useState(false);
  const [convertToken, setConvertToken] = useState(false);
  const [receiveToken, setReceiveToken] = useState(null);
  const [receiveNetwork, setReceiveNetwork] = useState(null);

  const [tokenModalOpen, setTokenModalOpen] = useState(false);
  const [tokenModalTarget, setTokenModalTarget] = useState("buy");
  // Lets a connected user browse past the owned-balance filter on the
  // sell/send picker — e.g. to pick a Tron/BTC/etc. origin their EVM wallet
  // can't hold, which then routes through the manual deposit flow.
  const [tokenModalShowAll, setTokenModalShowAll] = useState(false);
  const [tokenSearch, setTokenSearch] = useState("");
  const [networkFilter, setNetworkFilter] = useState("all");
  const [chainsExpanded, setChainsExpanded] = useState(false);
  const [liveTokens, setLiveTokens] = useState(null);
  const [liveTokensStatus, setLiveTokensStatus] = useState("loading"); // loading | live | offline
  const [ownedBalances, setOwnedBalances] = useState({}); // "SYMBOL|network" -> bigint
  const [ownedBalancesStatus, setOwnedBalancesStatus] = useState("idle"); // idle | loading | ready

  useEffect(() => {
    let cancelled = false;
    fetch("https://1click.chaindefuser.com/v0/tokens")
      .then((res) => {
        if (!res.ok) throw new Error("bad response");
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        const mapped = data
          .filter((t) => t.symbol && t.blockchain)
          .map((t) => ({
            symbol: t.symbol,
            network: t.blockchain,
            price: t.price,
            contractAddress: t.contractAddress,
            assetId: t.assetId,
            decimals: t.decimals,
          }));
        setLiveTokens(mapped);
        setLiveTokensStatus("live");
      })
      .catch(() => {
        if (!cancelled) setLiveTokensStatus("offline");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isConnected || !address || !liveTokens) {
      setOwnedBalances({});
      setOwnedBalancesStatus("idle");
      return;
    }

    let cancelled = false;
    setOwnedBalancesStatus("loading");
    fetchOwnedBalances(liveTokens, address).then((result) => {
      if (cancelled) return;
      setOwnedBalances(result);
      setOwnedBalancesStatus("ready");
    });

    return () => {
      cancelled = true;
    };
  }, [isConnected, address, liveTokens]);

  useEffect(() => {
    if (tokenModalOpen) setTokenModalShowAll(false);
  }, [tokenModalOpen, tokenModalTarget]);

  useEffect(() => {
    if (mode !== "swap" || !AURORA_QUOTE_URL) return;

    const originToken = findTokenRecord(liveTokens, sellTok, sellNetwork);
    const destToken = findTokenRecord(liveTokens, buyTok, buyNetwork);
    const amountNum = Number(sellAmt);

    // refundTo/recipient each need to be validly-formatted for their own
    // chain — a dummy EVM address won't do for a non-EVM origin/destination.
    // The preview doesn't care whose address it is, only that the FORMAT is
    // right, so prefer the token's own contract address (guaranteed valid
    // on that chain) over whatever's been typed so far — while the user is
    // still composing a non-EVM address, a partial/wrong-chain value here
    // would otherwise make the live preview fail with a misleading "no
    // route found" even though the route is fine. Only fall back to the
    // typed value for native non-EVM coins that have no contract address.
    const placeholderFor = (token, typed) => {
      const chainId = CHAIN_ID_BY_NETWORK[token?.network?.toLowerCase()];
      if (chainId) return (isConnected && address) || "0x0000000000000000000000000000000000000000";
      if (token?.contractAddress) return token.contractAddress;
      // Native coin with no contract address to fall back on — only use
      // what's typed if it's actually formatted right for this chain,
      // otherwise it's better to idle than attempt a doomed request that
      // shows up as a misleading "no route found".
      return typed && !addressLooksWrongForChain(typed, token?.network) ? typed : null;
    };
    const refundPlaceholder = placeholderFor(originToken, swapRefundAddress);
    const recipientPlaceholder = placeholderFor(destToken, swapRecipient);

    if (
      !originToken?.assetId ||
      !destToken?.assetId ||
      !amountNum ||
      amountNum <= 0 ||
      !refundPlaceholder ||
      !recipientPlaceholder
    ) {
      setBuyAmount("");
      setSwapFeeBps(null);
      setQuoteStatus("idle");
      return;
    }

    let cancelled = false;
    setQuoteStatus("loading");
    const slippageBps = Math.round(Number(customSlippage || slippage) * 100);

    const timeout = setTimeout(() => {
      fetchQuoteWithRetry(
        AURORA_QUOTE_URL,
        buildQuoteBody({
          dry: true,
          originToken,
          destToken,
          amountBaseUnits: toBaseUnits(sellAmt, originToken.decimals),
          slippageBps,
          recipient: recipientPlaceholder,
          refundTo: refundPlaceholder,
          confidential: swapPriv,
        }),
        { isCancelled: () => cancelled }
      )
        .then((data) => {
          if (cancelled) return;
          setBuyAmount(data.quote.amountOutFormatted);
          const totalFeeBps = (data.quoteRequest?.appFees || []).reduce((sum, f) => sum + (f.fee || 0), 0);
          setSwapFeeBps(totalFeeBps);
          setQuoteStatus("ok");
        })
        .catch(() => {
          if (!cancelled) {
            setBuyAmount("");
            setSwapFeeBps(null);
            setQuoteStatus("error");
          }
        });
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [
    mode,
    sellAmt,
    sellTok,
    sellNetwork,
    buyTok,
    buyNetwork,
    liveTokens,
    slippage,
    customSlippage,
    isConnected,
    address,
    swapPriv,
    swapRefundAddress,
    swapRecipient,
  ]);

  // A previous attempt's result no longer applies once the trade itself changes.
  useEffect(() => {
    setSwapStatus("idle");
    setSwapError("");
    setSwapTxHash("");
    setSwapStatusDetail("");
    setSwapDepositAddress("");
    setSwapDepositDeadline(null);
    setSwapDepositTimeEstimate(null);
  }, [sellAmt, sellTok, sellNetwork, buyTok, buyNetwork, swapPriv]);

  useEffect(() => {
    setSendStatus("idle");
    setSendError("");
    setSendTxHash("");
    setSendStatusDetail("");
    setSendDepositAddress("");
    setSendDepositDeadline(null);
    setSendDepositTimeEstimate(null);
  }, [sendAmt, sendTok, sendNetwork, recipient, priv, convertToken, receiveToken, receiveNetwork]);

  function pollSendStatus(depositAddress) {
    const token = ++sendPollToken.current;
    const check = () => {
      if (sendPollToken.current !== token) return;
      fetch(`${AURORA_STATUS_URL}?depositAddress=${depositAddress}`)
        .then((res) => {
          if (!res.ok) throw new Error("status check failed");
          return res.json();
        })
        .then((data) => {
          if (sendPollToken.current !== token) return;
          if (data.status === "SUCCESS") {
            setSendStatus("success");
            setSendStatusDetail("");
          } else if (data.status === "FAILED") {
            setSendStatus("failed");
            setSendStatusDetail("");
          } else if (data.status === "REFUNDED") {
            setSendStatus("refunded");
            setSendStatusDetail("");
          } else {
            // PENDING_DEPOSIT just means nothing's arrived yet — in manual
            // mode that's still "awaiting-deposit" (keep showing the
            // address), not "processing" (which implies we've seen it).
            if (data.status !== "PENDING_DEPOSIT") {
              setSendStatus("processing");
            }
            setSendStatusDetail(data.status);
            setTimeout(check, 3000);
          }
        })
        .catch(() => {
          if (sendPollToken.current !== token) return;
          setSendStatusDetail("waiting for the deposit to confirm on-chain...");
          setTimeout(check, 5000);
        });
    };
    check();
  }

  // Plain sends (no conversion, not private) skip the intents/quote system
  // entirely — it's just a direct transfer to the recipient. Conversion or
  // privacy both require routing through a deposit + Confidential Intents,
  // same machinery as a swap, because a same-chain wallet transfer can't be
  // made to hide the sender/recipient link on its own.
  async function handleSend() {
    if (!recipient) {
      setSendStatus("error");
      setSendError("enter a recipient address");
      return;
    }
    if (!sendAmt || Number(sendAmt) <= 0) {
      setSendStatus("error");
      setSendError("enter an amount to send");
      return;
    }

    const originToken = findTokenRecord(liveTokens, sendTok, sendNetwork);
    if (!originToken) {
      setSendStatus("error");
      setSendError("token data is still loading — try again in a moment");
      return;
    }

    const destToken = convertToken ? findTokenRecord(liveTokens, receiveToken, receiveNetwork) : originToken;
    if (convertToken && !destToken) {
      setSendStatus("error");
      setSendError("pick a token for the recipient to receive");
      return;
    }

    const chainId = CHAIN_ID_BY_NETWORK[sendNetwork?.toLowerCase()];
    const canAutoSign = isConnected && Boolean(chainId);
    const executionMode = canAutoSign && !sendManualOverride ? "wallet" : "manual";

    if (executionMode === "wallet" && (!isConnected || !address)) {
      open();
      return;
    }
    if (executionMode === "manual") {
      if (!sendRefundAddress) {
        setSendStatus("error");
        setSendError("enter your own address on the origin chain (for refunds)");
        return;
      }
      if (addressLooksWrongForChain(sendRefundAddress, sendNetwork)) {
        setSendStatus("error");
        setSendError(`that doesn't look like a ${sendNetwork} address`);
        return;
      }
    }

    // A non-EVM origin chain has no "plain wallet transfer" option at all —
    // it always has to route through the Aurora deposit flow, whether or
    // not privacy/convert are checked.
    const needsIntents = priv || convertToken || !chainId;
    const isNative = Boolean(chainId) && NATIVE_SYMBOL_BY_CHAIN[chainId] === originToken.symbol;
    const destNetwork = convertToken ? receiveNetwork : sendNetwork;
    if (needsIntents && addressLooksWrongForChain(recipient, destNetwork)) {
      setSendStatus("error");
      setSendError(`that doesn't look like a ${destNetwork} address`);
      return;
    }

    try {
      setSendError("");
      setSendTxHash("");
      setSendStatusDetail("");

      if (!needsIntents) {
        if (!isEvmAddress(recipient)) {
          setSendStatus("error");
          setSendError("enter a valid 0x recipient address for a direct send");
          return;
        }

        setSendStatus("awaiting-signature");
        await ensureChain(chainId);
        const amountBaseUnits = toBaseUnits(sendAmt, originToken.decimals ?? 18);
        const txHash = isNative
          ? await sendTransaction(wagmiConfig, { chainId, to: recipient, value: BigInt(amountBaseUnits) })
          : await writeContract(wagmiConfig, {
              chainId,
              address: originToken.contractAddress,
              abi: ERC20_ABI,
              functionName: "transfer",
              args: [recipient, BigInt(amountBaseUnits)],
            });

        setSendTxHash(txHash);
        setLastTxHash(txHash);
        setLastTxChainId(chainId);
        setSendStatus("processing");
        setSendStatusDetail("confirming on-chain...");

        await waitForTransactionReceipt(wagmiConfig, { chainId, hash: txHash });
        setSendStatus("success");
        setSendStatusDetail("");
        return;
      }

      if (!originToken.assetId || !destToken?.assetId) {
        setSendStatus("error");
        setSendError("token data is still loading — try again in a moment");
        return;
      }

      setSendStatus("quoting");
      const amountBaseUnits = toBaseUnits(sendAmt, originToken.decimals);
      const slippageBps = Math.round(Number(customSlippage || slippage) * 100);

      const res = await fetch(AURORA_QUOTE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildQuoteBody({
            dry: false,
            originToken,
            destToken,
            amountBaseUnits,
            slippageBps,
            recipient,
            refundTo: executionMode === "wallet" ? address : sendRefundAddress,
            confidential: priv,
          })
        ),
      });
      if (!res.ok) throw new Error(await quoteErrorMessage(res));
      const quoteData = await res.json();
      const depositAddress = quoteData.quote?.depositAddress;
      if (!depositAddress) throw new Error("no deposit address returned");

      if (executionMode === "manual") {
        setSendDepositAddress(depositAddress);
        setSendDepositDeadline(quoteData.quote?.deadline || null);
        setSendDepositTimeEstimate(quoteData.quote?.timeEstimate || null);
        setSendStatus("awaiting-deposit");
        pollSendStatus(depositAddress);
        return;
      }

      setSendStatus("awaiting-signature");
      await ensureChain(chainId);

      const txHash = isNative
        ? await sendTransaction(wagmiConfig, { chainId, to: depositAddress, value: BigInt(amountBaseUnits) })
        : await writeContract(wagmiConfig, {
            chainId,
            address: originToken.contractAddress,
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [depositAddress, BigInt(amountBaseUnits)],
          });

      setSendTxHash(txHash);
      setLastTxHash(txHash);
      setLastTxChainId(chainId);
      setSendStatus("pending-deposit");

      if (AURORA_DEPOSIT_SUBMIT_URL) {
        fetch(AURORA_DEPOSIT_SUBMIT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ txHash, depositAddress }),
        }).catch(() => {});
      }

      pollSendStatus(depositAddress);
    } catch (err) {
      setSendStatus("error");
      setSendError(err?.shortMessage || err?.message || "send failed");
    }
  }

  function pollSwapStatus(depositAddress) {
    const token = ++swapPollToken.current;
    const check = () => {
      if (swapPollToken.current !== token) return;
      fetch(`${AURORA_STATUS_URL}?depositAddress=${depositAddress}`)
        .then((res) => {
          if (!res.ok) throw new Error("status check failed");
          return res.json();
        })
        .then((data) => {
          if (swapPollToken.current !== token) return;
          if (data.status === "SUCCESS") {
            setSwapStatus("success");
            setSwapStatusDetail("");
          } else if (data.status === "FAILED") {
            setSwapStatus("failed");
            setSwapStatusDetail("");
          } else if (data.status === "REFUNDED") {
            setSwapStatus("refunded");
            setSwapStatusDetail("");
          } else {
            // KNOWN_DEPOSIT_TX | PENDING_DEPOSIT | INCOMPLETE_DEPOSIT | PROCESSING
            // PENDING_DEPOSIT just means nothing's arrived yet — in manual
            // mode that's still "awaiting-deposit" (keep showing the
            // address), not "processing" (which implies we've seen it).
            if (data.status !== "PENDING_DEPOSIT") {
              setSwapStatus("processing");
            }
            setSwapStatusDetail(data.status);
            setTimeout(check, 3000);
          }
        })
        .catch(() => {
          if (swapPollToken.current !== token) return;
          // The deposit tx was just broadcast — the indexer often hasn't
          // picked it up yet, so a 404 here right after signing is normal.
          setSwapStatusDetail("waiting for the deposit to confirm on-chain...");
          setTimeout(check, 5000);
        });
    };
    check();
  }

  async function handleSwap() {
    if (!AURORA_QUOTE_URL) {
      setSwapStatus("error");
      setSwapError("Aurora API key isn't configured (VITE_AURORA_API_KEY missing)");
      return;
    }
    if (!buyTok || !buyNetwork) {
      setSwapStatus("error");
      setSwapError("pick a token to buy first");
      return;
    }
    if (!sellAmt || Number(sellAmt) <= 0) {
      setSwapStatus("error");
      setSwapError("enter an amount to sell");
      return;
    }

    const originToken = findTokenRecord(liveTokens, sellTok, sellNetwork);
    const destToken = findTokenRecord(liveTokens, buyTok, buyNetwork);
    if (!originToken?.assetId || !destToken?.assetId) {
      setSwapStatus("error");
      setSwapError("token data is still loading — try again in a moment");
      return;
    }

    const chainId = CHAIN_ID_BY_NETWORK[originToken.network?.toLowerCase()];
    const canAutoSign = isConnected && Boolean(chainId);
    const executionMode = canAutoSign && !swapManualOverride ? "wallet" : "manual";

    if (executionMode === "wallet" && (!isConnected || !address)) {
      open();
      return;
    }
    if (executionMode === "manual") {
      if (!swapRefundAddress) {
        setSwapStatus("error");
        setSwapError("enter your own address on the origin chain (for refunds)");
        return;
      }
      if (addressLooksWrongForChain(swapRefundAddress, sellNetwork)) {
        setSwapStatus("error");
        setSwapError(`that doesn't look like a ${sellNetwork} address`);
        return;
      }
    }

    const destChainId = CHAIN_ID_BY_NETWORK[buyNetwork?.toLowerCase()];
    const finalRecipient = swapRecipient || (isConnected && destChainId ? address : "");
    if (!finalRecipient) {
      setSwapStatus("error");
      setSwapError("enter a recipient address for the destination chain");
      return;
    }
    if (addressLooksWrongForChain(finalRecipient, buyNetwork)) {
      setSwapStatus("error");
      setSwapError(`that doesn't look like a ${buyNetwork} address`);
      return;
    }
    const amountBaseUnits = toBaseUnits(sellAmt, originToken.decimals);
    const slippageBps = Math.round(Number(customSlippage || slippage) * 100);

    try {
      setSwapError("");
      setSwapTxHash("");
      setSwapStatusDetail("");
      setSwapStatus("quoting");

      const res = await fetch(AURORA_QUOTE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildQuoteBody({
            dry: false,
            originToken,
            destToken,
            amountBaseUnits,
            slippageBps,
            recipient: finalRecipient,
            refundTo: executionMode === "wallet" ? address : swapRefundAddress,
            confidential: swapPriv,
          })
        ),
      });
      if (!res.ok) throw new Error(await quoteErrorMessage(res));
      const quoteData = await res.json();
      const depositAddress = quoteData.quote?.depositAddress;
      if (!depositAddress) throw new Error("no deposit address returned");

      if (executionMode === "manual") {
        setSwapDepositAddress(depositAddress);
        setSwapDepositDeadline(quoteData.quote?.deadline || null);
        setSwapDepositTimeEstimate(quoteData.quote?.timeEstimate || null);
        setSwapStatus("awaiting-deposit");
        pollSwapStatus(depositAddress);
        return;
      }

      setSwapStatus("awaiting-signature");
      await ensureChain(chainId);

      const isNative = NATIVE_SYMBOL_BY_CHAIN[chainId] === originToken.symbol;
      const txHash = isNative
        ? await sendTransaction(wagmiConfig, {
            chainId,
            to: depositAddress,
            value: BigInt(amountBaseUnits),
          })
        : await writeContract(wagmiConfig, {
            chainId,
            address: originToken.contractAddress,
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [depositAddress, BigInt(amountBaseUnits)],
          });

      setSwapTxHash(txHash);
      setLastTxHash(txHash);
      setLastTxChainId(chainId);
      setSwapStatus("pending-deposit");

      if (AURORA_DEPOSIT_SUBMIT_URL) {
        fetch(AURORA_DEPOSIT_SUBMIT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ txHash, depositAddress }),
        }).catch(() => {});
      }

      pollSwapStatus(depositAddress);
    } catch (err) {
      setSwapStatus("error");
      setSwapError(err?.shortMessage || err?.message || "swap failed");
    }
  }

  const swapOriginChainId = CHAIN_ID_BY_NETWORK[sellNetwork?.toLowerCase()];
  const swapCanAutoSign = isConnected && Boolean(swapOriginChainId);
  const swapExecutionMode = swapCanAutoSign && !swapManualOverride ? "wallet" : "manual";
  const swapDestChainId = CHAIN_ID_BY_NETWORK[buyNetwork?.toLowerCase()];
  const swapRecipientRequired = !(isConnected && swapDestChainId);

  const sendOriginChainId = CHAIN_ID_BY_NETWORK[sendNetwork?.toLowerCase()];
  const sendCanAutoSign = isConnected && Boolean(sendOriginChainId);
  const sendExecutionMode = sendCanAutoSign && !sendManualOverride ? "wallet" : "manual";

  const swapBusy = ["quoting", "awaiting-signature", "pending-deposit", "awaiting-deposit", "processing"].includes(swapStatus);
  const swapButtonLabel =
    {
      quoting: "getting live quote...",
      "awaiting-signature": "confirm in wallet...",
      "pending-deposit": "sending deposit...",
      "awaiting-deposit": "waiting for your deposit...",
      processing: "processing swap...",
      success: "swap complete — do another",
      failed: "swap failed — try again",
      refunded: "refunded — try again",
      error: "try again",
    }[swapStatus] ||
    (swapExecutionMode === "manual" ? "get deposit address" : swapPriv ? "review private swap" : "review swap");

  const sendBusy = ["quoting", "awaiting-signature", "pending-deposit", "awaiting-deposit", "processing"].includes(sendStatus);
  const sendButtonLabel =
    {
      quoting: "getting live quote...",
      "awaiting-signature": "confirm in wallet...",
      "pending-deposit": "sending deposit...",
      "awaiting-deposit": "waiting for your deposit...",
      processing: "processing...",
      success: "sent — send another",
      failed: "send failed — try again",
      refunded: "refunded — try again",
      error: "try again",
    }[sendStatus] ||
    (sendExecutionMode === "manual" ? "get deposit address" : priv ? "send privately" : "send");

  const mainButtonLabel = mode === "swap" ? swapButtonLabel : sendButtonLabel;
  const mainButtonBusy = mode === "swap" ? swapBusy : sendBusy;

  // "sell" and "send" both draw from your wallet — only "buy"/"receive" pick
  // an arbitrary token to acquire, so they show price instead of balance.
  const ownedOnlyTarget = tokenModalTarget === "sell" || tokenModalTarget === "send";

  const sellChainId = CHAIN_ID_BY_NETWORK[sellNetwork?.toLowerCase()];
  const sellTokenRecord = findTokenRecord(liveTokens, sellTok, sellNetwork);
  const sellBalanceRaw = ownedBalances[`${sellTok}|${sellNetwork}`];
  const sellIsNative = Boolean(sellChainId) && NATIVE_SYMBOL_BY_CHAIN[sellChainId] === sellTok;
  const sellBalanceFormatted =
    isConnected && sellBalanceRaw !== undefined
      ? truncateDecimalString(formatUnits(sellBalanceRaw, sellTokenRecord?.decimals ?? 18), 6)
      : null;

  function fillSellAmount(fraction) {
    if (sellBalanceRaw === undefined || !sellTokenRecord) return;
    const decimals = sellTokenRecord.decimals ?? 18;
    let usable = fraction === 1 ? sellBalanceRaw : sellBalanceRaw / 2n;
    if (fraction === 1 && sellIsNative) {
      const reserveRaw = BigInt(Math.round((GAS_RESERVE_NATIVE[sellChainId] ?? 0.002) * 10 ** decimals));
      usable = usable > reserveRaw ? usable - reserveRaw : 0n;
    }
    setSellAmt(truncateDecimalString(formatUnits(usable, decimals), decimals));
  }

  // Flips sell/buy — the quoted output becomes the new input, same as
  // clicking the reverse arrow on any other swap UI.
  function flipSwapTokens() {
    const nextSellTok = buyTok;
    const nextSellNetwork = buyNetwork;
    const nextBuyTok = sellTok;
    const nextBuyNetwork = sellNetwork;
    setSellTok(nextSellTok);
    setSellNetwork(nextSellNetwork);
    setBuyTok(nextBuyTok);
    setBuyNetwork(nextBuyNetwork);
    setSellAmt(buyAmount || "");
  }

  const ink = "#0A0A0A";
  const gray = "#6B6B6B";
  const line = "#D8D6CE";
  const paper = "#FDFCF9";

  return (
    <div
      style={{
        position: "relative",
        background: paper,
        minHeight: "100vh",
        fontFamily: "'IBM Plex Mono', monospace",
        color: ink,
        overflowX: "hidden",
        padding: "20px 20px 60px",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .hood-field::placeholder { color: #B9B6AB; }
        .hood-tab { cursor: pointer; }
        .hood-cta:hover { background: ${ink} !important; color: ${paper} !important; }
        .hood-tip-wrap { position: relative; display: inline-flex; }
        .hood-tip {
          position: absolute;
          bottom: 22px;
          left: 50%;
          transform: translateX(-50%);
          background: ${ink};
          color: ${paper};
          font-size: 11px;
          padding: 6px 10px;
          width: 200px;
          text-align: center;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.15s ease;
          z-index: 5;
        }
        .hood-tip-wrap:hover .hood-tip { opacity: 1; }
        .hood-card-scale { transform: scale(1.1); }
        @media (max-width: 480px) { .hood-card-scale { transform: none; } }
        @media (max-width: 560px) {
          .hood-header-nav { order: 3; width: 100%; justify-content: center; gap: 14px; font-size: 12px; }
        }
        @media (max-width: 480px) {
          .hood-mascot-wrap { position: static !important; margin: 28px auto 0; justify-content: center !important; }
        }
      `}</style>

      {/* header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", rowGap: 10, margin: "0 0 32px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }} onClick={() => setTopTab("app")}>
          <div style={{ fontSize: 28, fontWeight: 600, lineHeight: 1 }}>[hood]</div>
        </div>

        <div className="hood-header-nav" style={{ display: "flex", gap: 20, fontSize: 13 }}>
          {[
            { key: "app", label: "Swap" },
            { key: "borrow", label: "Borrow" },
            { key: "how", label: "How it work?" },
            { key: "club", label: "Hood club" },
          ].map(({ key, label }) => (
            <span
              key={key}
              onClick={() => setTopTab(key)}
              style={{
                cursor: "pointer",
                paddingBottom: 2,
                color: topTab === key ? ink : gray,
                borderBottom: topTab === key ? `1px solid ${ink}` : "1px solid transparent",
              }}
            >
              {label}
            </span>
          ))}
          <a
            href="https://x.com/hood_swap"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: gray, textDecoration: "none", paddingBottom: 2, borderBottom: "1px solid transparent" }}
          >
            X
          </a>
        </div>

        <div style={{ position: "relative" }}>
          <button
            className="hood-cta"
            onClick={() => (isConnected ? setWalletMenuOpen((v) => !v) : open())}
            style={{
              border: `1px solid ${ink}`,
              background: "transparent",
              color: ink,
              fontFamily: "inherit",
              fontSize: 12,
              padding: "8px 14px",
              cursor: "pointer",
            }}
          >
            {isConnected ? `[ ${address.slice(0, 6)}…${address.slice(-4)} ]` : "[ connect wallet ]"}
          </button>
          {walletMenuOpen && isConnected && (
            <WalletMenu
              address={address}
              ink={ink}
              gray={gray}
              line={line}
              paper={paper}
              onClose={() => setWalletMenuOpen(false)}
            />
          )}
        </div>
      </div>

      {topTab === "how" && (
        <HowItWorks ink={ink} gray={gray} line={line} paper={paper} howLevel={howLevel} setHowLevel={setHowLevel} />
      )}

      {topTab === "club" && (
        <div style={{ maxWidth: 420, margin: "0 auto" }}>
          <div style={{ border: `1px solid ${ink}`, background: paper, padding: 32, textAlign: "center" }}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
              <HoodMark size={40} ink={ink} paper={paper} />
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>hood club is still getting ready.</div>
            <p style={{ fontSize: 13, color: gray, lineHeight: 1.6, margin: 0 }}>no waitlist. no pre-sign-up. nothing to fill in.</p>
            <p style={{ fontSize: 13, color: gray, lineHeight: 1.6, margin: "10px 0 0" }}>
              just wait — when it's ready, the club will find you.
            </p>
          </div>
          <div style={{ textAlign: "center", marginTop: 22 }}>
            <HoodAsciiArt ink={ink} />
          </div>
        </div>
      )}

      {topTab === "borrow" && (
        <BorrowPanel
          ink={ink}
          gray={gray}
          line={line}
          paper={paper}
          liveTokens={liveTokens}
          ownedBalances={ownedBalances}
          ownedBalancesStatus={ownedBalancesStatus}
          isConnected={isConnected}
          address={address}
          open={open}
        />
      )}

      {topTab === "app" && (
      <>
      {/* card */}
      <div style={{ maxWidth: 380, margin: "0 auto", paddingBottom: 40 }}>
      <div className="hood-card-scale" style={{ border: `1px solid ${ink}`, background: paper, transformOrigin: "top center" }}>
        {/* tabs */}
        <div style={{ display: "flex", borderBottom: `1px solid ${ink}` }}>
          <div
            className="hood-tab"
            onClick={() => setMode("swap")}
            style={{
              flex: 1,
              textAlign: "center",
              padding: "10px 0",
              fontSize: 13,
              borderRight: `1px solid ${ink}`,
              background: mode === "swap" ? ink : "transparent",
              color: mode === "swap" ? paper : ink,
            }}
          >
            [ swap ]
          </div>
          <div
            className="hood-tab"
            onClick={() => setMode("send")}
            style={{
              flex: 1,
              textAlign: "center",
              padding: "10px 0",
              fontSize: 13,
              fontWeight: 600,
              background: mode === "send" ? ink : "transparent",
              color: mode === "send" ? paper : ink,
            }}
          >
            [ send ]
          </div>
        </div>

        <div style={{ padding: 16 }}>
          {mode === "swap" ? (
            <>
              <FieldRow
                label="sell"
                value={sellAmt}
                onChange={setSellAmt}
                token={sellTok}
                network={sellNetwork}
                selectToken
                onSelectClick={() => {
                  setTokenModalTarget("sell");
                  setTokenModalOpen(true);
                }}
                gray={gray}
                line={line}
                ink={ink}
                bold
              />
              {isConnected && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: gray, marginTop: 4 }}>
                  <span>{sellBalanceFormatted !== null ? `balance: ${sellBalanceFormatted}` : ""}</span>
                  {sellBalanceFormatted !== null && (
                    <span>
                      <span onClick={() => fillSellAmount(0.5)} style={{ cursor: "pointer", textDecoration: "underline", marginRight: 10 }}>
                        50%
                      </span>
                      <span onClick={() => fillSellAmount(1)} style={{ cursor: "pointer", textDecoration: "underline" }}>
                        max
                      </span>
                    </span>
                  )}
                </div>
              )}
              <div
                onClick={flipSwapTokens}
                style={{ textAlign: "center", fontSize: 12, color: gray, margin: "6px 0", cursor: "pointer" }}
              >
                [ v ]
              </div>
              <FieldRow
                label="buy"
                value=""
                placeholder={quoteStatus === "loading" ? "..." : buyAmount || "0"}
                token={buyTok}
                network={buyNetwork}
                selectToken
                onSelectClick={() => {
                  setTokenModalTarget("buy");
                  setTokenModalOpen(true);
                }}
                gray={gray}
                line={line}
                ink={ink}
                bold
              />
              {quoteStatus === "error" && (
                <div style={{ fontSize: 11, color: gray, marginTop: 2 }}>no route found for this pair</div>
              )}
              {quoteStatus === "ok" && swapFeeBps !== null && (
                <div style={{ fontSize: 11, color: gray, marginTop: 2 }}>fee: {(swapFeeBps / 100).toFixed(2)}%</div>
              )}

              {swapExecutionMode === "manual" && (
                <div style={{ marginTop: 12, marginBottom: 4 }}>
                  <div style={{ fontSize: 11, color: gray, marginBottom: 4 }}>
                    your {sellNetwork} address (for refunds)
                  </div>
                  <input
                    value={swapRefundAddress}
                    onChange={(e) => setSwapRefundAddress(e.target.value)}
                    placeholder={`address on ${sellNetwork}`}
                    className="hood-field"
                    style={{
                      width: "100%",
                      border: "none",
                      borderBottom: `1px solid ${line}`,
                      outline: "none",
                      padding: "6px 0",
                      fontSize: 13,
                      fontFamily: "inherit",
                      background: "transparent",
                      color: ink,
                    }}
                  />
                </div>
              )}

              <div style={{ marginTop: 12, marginBottom: 4 }}>
                <div style={{ fontSize: 11, color: gray, marginBottom: 4 }}>
                  {swapRecipientRequired ? "recipient address (required)" : "recipient wallet (optional)"}
                </div>
                <input
                  value={swapRecipient}
                  onChange={(e) => setSwapRecipient(e.target.value)}
                  placeholder={swapRecipientRequired ? `address on ${buyNetwork || "destination chain"}` : "defaults to your own wallet"}
                  className="hood-field"
                  style={{
                    width: "100%",
                    border: "none",
                    borderBottom: `1px solid ${line}`,
                    outline: "none",
                    padding: "6px 0",
                    fontSize: 13,
                    fontFamily: "inherit",
                    background: "transparent",
                    color: ink,
                  }}
                />
              </div>

              {swapCanAutoSign && (
                <div
                  onClick={() => setSwapManualOverride(!swapManualOverride)}
                  style={{ marginTop: 6, fontSize: 11, color: gray, cursor: "pointer", textDecoration: "underline" }}
                >
                  {swapManualOverride ? "[ use connected wallet instead ]" : "[ use a deposit address instead ]"}
                </div>
              )}

              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 14, fontSize: 13 }}>
                <span onClick={() => setSwapPriv(!swapPriv)} style={{ flexShrink: 0, cursor: "pointer" }}>
                  [{swapPriv ? "x" : " "}]
                </span>
                <span onClick={() => setSwapPriv(!swapPriv)} style={{ cursor: "pointer" }}>
                  make swap private
                </span>
                <span className="hood-tip-wrap">
                  <span
                    style={{
                      border: `1px solid ${gray}`,
                      borderRadius: "50%",
                      width: 14,
                      height: 14,
                      fontSize: 10,
                      fontStyle: "italic",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: gray,
                      cursor: "default",
                      flexShrink: 0,
                    }}
                  >
                    i
                  </span>
                  <span className="hood-tip">
                    the recipient and any onlookers won't be able to see your wallet address.
                  </span>
                </span>
              </div>

              <div style={{ marginTop: 14 }}>
                <div
                  onClick={() => setShowMoreSettings(!showMoreSettings)}
                  style={{
                    fontSize: 12,
                    color: gray,
                    cursor: "pointer",
                  }}
                >
                  [ more settings {showMoreSettings ? "▲" : "▼"} ]
                </div>

                {showMoreSettings && (
                  <div style={{ marginTop: 10, borderTop: `1px solid ${line}`, paddingTop: 10 }}>
                    <div
                      onClick={() => setShowSlippage(!showSlippage)}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: 12,
                        color: gray,
                        cursor: "pointer",
                      }}
                    >
                      <span>slippage tolerance</span>
                      <span style={{ color: ink, borderBottom: `1px solid ${ink}` }}>
                        {customSlippage || slippage}% {showSlippage ? "▲" : "▼"}
                      </span>
                    </div>

                    {showSlippage && (
                      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                        {slippagePresets.map((p) => (
                          <div
                            key={p}
                            onClick={() => {
                              setSlippage(p);
                              setCustomSlippage("");
                            }}
                            style={{
                              flex: 1,
                              textAlign: "center",
                              padding: "6px 0",
                              fontSize: 12,
                              border: `1px solid ${ink}`,
                              cursor: "pointer",
                              background: !customSlippage && slippage === p ? ink : "transparent",
                              color: !customSlippage && slippage === p ? paper : ink,
                            }}
                          >
                            {p}%
                          </div>
                        ))}
                        <input
                          value={customSlippage}
                          onChange={(e) => setCustomSlippage(e.target.value)}
                          placeholder="custom"
                          className="hood-field"
                          style={{
                            flex: 1,
                            textAlign: "center",
                            padding: "6px 4px",
                            fontSize: 12,
                            border: `1px solid ${customSlippage ? ink : line}`,
                            outline: "none",
                            fontFamily: "inherit",
                            background: "transparent",
                            color: ink,
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <FieldRow
                label="amount"
                value={sendAmt}
                onChange={setSendAmt}
                token={sendTok}
                network={sendNetwork}
                selectToken
                onSelectClick={() => {
                  setTokenModalTarget("send");
                  setTokenModalOpen(true);
                }}
                gray={gray}
                line={line}
                ink={ink}
                bold
              />

              <div style={{ marginTop: 14 }}>
                <div
                  onClick={() => setConvertToken(!convertToken)}
                  style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, cursor: "pointer" }}
                >
                  <span style={{ flexShrink: 0 }}>[{convertToken ? "x" : " "}]</span>
                  <span>convert to a different token for the recipient</span>
                </div>

                {convertToken && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11, color: gray, marginBottom: 4 }}>receive as</div>
                    <div
                      onClick={() => {
                        setTokenModalTarget("receive");
                        setTokenModalOpen(true);
                      }}
                      style={{
                        border: `1px solid ${line}`,
                        padding: "10px 12px",
                        fontSize: 13,
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <span>
                        {receiveToken ? `${receiveToken} on ${receiveNetwork}` : "select token"}
                      </span>
                      <span style={{ color: gray }}>▾</span>
                    </div>

                    <div style={{ marginTop: 12 }}>
                      <div
                        onClick={() => setShowSlippage(!showSlippage)}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          fontSize: 12,
                          color: gray,
                          cursor: "pointer",
                        }}
                      >
                        <span>slippage tolerance</span>
                        <span style={{ color: ink, borderBottom: `1px solid ${ink}` }}>
                          {customSlippage || slippage}% {showSlippage ? "▲" : "▼"}
                        </span>
                      </div>

                      {showSlippage && (
                        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                          {slippagePresets.map((p) => (
                            <div
                              key={p}
                              onClick={() => {
                                setSlippage(p);
                                setCustomSlippage("");
                              }}
                              style={{
                                flex: 1,
                                textAlign: "center",
                                padding: "6px 0",
                                fontSize: 12,
                                border: `1px solid ${ink}`,
                                cursor: "pointer",
                                background: !customSlippage && slippage === p ? ink : "transparent",
                                color: !customSlippage && slippage === p ? paper : ink,
                              }}
                            >
                              {p}%
                            </div>
                          ))}
                          <input
                            value={customSlippage}
                            onChange={(e) => setCustomSlippage(e.target.value)}
                            placeholder="custom"
                            className="hood-field"
                            style={{
                              flex: 1,
                              textAlign: "center",
                              padding: "6px 4px",
                              fontSize: 12,
                              border: `1px solid ${customSlippage ? ink : line}`,
                              outline: "none",
                              fontFamily: "inherit",
                              background: "transparent",
                              color: ink,
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {sendExecutionMode === "manual" && (
                <div style={{ marginTop: 14, marginBottom: 4 }}>
                  <div style={{ fontSize: 11, color: gray, marginBottom: 4 }}>
                    your {sendNetwork} address (for refunds)
                  </div>
                  <input
                    value={sendRefundAddress}
                    onChange={(e) => setSendRefundAddress(e.target.value)}
                    placeholder={`address on ${sendNetwork}`}
                    className="hood-field"
                    style={{
                      width: "100%",
                      border: "none",
                      borderBottom: `1px solid ${line}`,
                      outline: "none",
                      padding: "6px 0",
                      fontSize: 13,
                      fontFamily: "inherit",
                      background: "transparent",
                      color: ink,
                    }}
                  />
                </div>
              )}

              <div style={{ marginTop: 14, marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: gray, marginBottom: 4 }}>recipient</div>
                <input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="0x... or name.near"
                  className="hood-field"
                  style={{
                    width: "100%",
                    border: "none",
                    borderBottom: `1px solid ${line}`,
                    outline: "none",
                    padding: "6px 0",
                    fontSize: 13,
                    fontFamily: "inherit",
                    background: "transparent",
                    color: ink,
                  }}
                />
              </div>

              {sendCanAutoSign && (
                <div
                  onClick={() => setSendManualOverride(!sendManualOverride)}
                  style={{ marginTop: -6, marginBottom: 6, fontSize: 11, color: gray, cursor: "pointer", textDecoration: "underline" }}
                >
                  {sendManualOverride ? "[ use connected wallet instead ]" : "[ use a deposit address instead ]"}
                </div>
              )}

              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 14, fontSize: 13 }}>
                <span onClick={() => setPriv(!priv)} style={{ flexShrink: 0, cursor: "pointer" }}>
                  [{priv ? "x" : " "}]
                </span>
                <span onClick={() => setPriv(!priv)} style={{ cursor: "pointer" }}>
                  send privately
                </span>
                <span className="hood-tip-wrap">
                  <span
                    style={{
                      border: `1px solid ${gray}`,
                      borderRadius: "50%",
                      width: 14,
                      height: 14,
                      fontSize: 10,
                      fontStyle: "italic",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: gray,
                      cursor: "default",
                      flexShrink: 0,
                    }}
                  >
                    i
                  </span>
                  <span className="hood-tip">
                    the recipient and any onlookers won't be able to see your wallet address.
                  </span>
                </span>
              </div>
            </>
          )}

          <button
            className="hood-cta"
            onClick={mode === "swap" ? handleSwap : handleSend}
            disabled={mainButtonBusy}
            style={{
              width: "100%",
              marginTop: 16,
              padding: "11px 0",
              border: `1px solid ${ink}`,
              background: "transparent",
              color: ink,
              fontFamily: "inherit",
              fontSize: 13,
              letterSpacing: 1,
              cursor: mainButtonBusy ? "default" : "pointer",
              opacity: mainButtonBusy ? 0.6 : 1,
            }}
          >
            {mainButtonLabel}
          </button>

          {mode === "swap" && swapStatus !== "idle" && swapStatus !== "awaiting-deposit" && (
            <div style={{ marginTop: 8, fontSize: 11, color: swapStatus === "error" || swapStatus === "failed" ? "#B3261E" : gray }}>
              {(swapStatus === "error" || swapStatus === "failed" || swapStatus === "refunded") &&
                (swapError || swapStatus)}
              {swapStatus === "processing" && (STATUS_DETAIL_LABEL[swapStatusDetail] || swapStatusDetail)}
              {swapStatus === "pending-deposit" && swapStatusDetail}
              {swapTxHash && (
                <div>
                  deposit tx:{" "}
                  <a
                    href={`${EXPLORER_BY_CHAIN[CHAIN_ID_BY_NETWORK[sellNetwork?.toLowerCase()]] || "https://etherscan.io"}/tx/${swapTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "inherit" }}
                  >
                    {swapTxHash.slice(0, 10)}…
                  </a>
                </div>
              )}
            </div>
          )}

          {mode === "swap" && swapStatus === "awaiting-deposit" && swapDepositAddress && (
            <DepositPanel
              address={swapDepositAddress}
              amountLabel={sellAmt}
              symbol={sellTok}
              network={sellNetwork}
              deadline={swapDepositDeadline}
              timeEstimate={swapDepositTimeEstimate}
              statusDetail={swapStatusDetail}
              ink={ink}
              gray={gray}
              line={line}
              paper={paper}
            />
          )}

          {mode === "send" && sendStatus !== "idle" && sendStatus !== "awaiting-deposit" && (
            <div style={{ marginTop: 8, fontSize: 11, color: sendStatus === "error" || sendStatus === "failed" ? "#B3261E" : gray }}>
              {(sendStatus === "error" || sendStatus === "failed" || sendStatus === "refunded") &&
                (sendError || sendStatus)}
              {(sendStatus === "processing" || sendStatus === "pending-deposit") &&
                (STATUS_DETAIL_LABEL[sendStatusDetail] || sendStatusDetail)}
              {sendTxHash && (
                <div>
                  tx:{" "}
                  <a
                    href={`${EXPLORER_BY_CHAIN[CHAIN_ID_BY_NETWORK[sendNetwork?.toLowerCase()]] || "https://etherscan.io"}/tx/${sendTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "inherit" }}
                  >
                    {sendTxHash.slice(0, 10)}…
                  </a>
                </div>
              )}
            </div>
          )}

          {mode === "send" && sendStatus === "awaiting-deposit" && sendDepositAddress && (
            <DepositPanel
              address={sendDepositAddress}
              amountLabel={sendAmt}
              symbol={sendTok}
              network={sendNetwork}
              deadline={sendDepositDeadline}
              timeEstimate={sendDepositTimeEstimate}
              statusDetail={sendStatusDetail}
              ink={ink}
              gray={gray}
              line={line}
              paper={paper}
            />
          )}
        </div>
      </div>
      </div>
      </>
      )}

      {topTab !== "club" && (
        <div style={{ textAlign: "center", marginTop: 22, fontSize: 11, color: gray }}>
          powered by near intents
        </div>
      )}

      <div className="hood-mascot-wrap" style={{ position: "fixed", left: 20, bottom: 20, display: "flex", alignItems: "flex-end", gap: 8, zIndex: 10 }}>
        <div style={{ border: `1px solid ${ink}`, background: paper, padding: "4px 7px", fontSize: 15, lineHeight: 1 }}>(•_•)</div>
        <div style={{ border: `1px solid ${ink}`, background: paper, padding: "8px 12px", fontSize: 11, maxWidth: 240 }}>
          send only funds, not information about yourself.
        </div>
      </div>

      {lastTxHash && (
        <div style={{ position: "fixed", right: 20, bottom: 20, zIndex: 10 }}>
          <div style={{ border: `1px solid ${ink}`, background: paper, padding: "8px 12px", fontSize: 11 }}>
            last deposit tx:{" "}
            <a
              href={`${EXPLORER_BY_CHAIN[lastTxChainId] || "https://etherscan.io"}/tx/${lastTxHash}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "inherit" }}
            >
              {lastTxHash.slice(0, 10)}…{lastTxHash.slice(-6)}
            </a>
          </div>
        </div>
      )}

      {/* <div style={{ position: "absolute", bottom: 16, right: 16, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        <div style={{ border: `1px solid ${ink}`, padding: "6px 10px", fontSize: 11, maxWidth: 170, textAlign: "right" }}>
          {showError ? "error" : "click if you don't know what to buy"}
        </div>
        <button
          onClick={() => setShowError(!showError)}
          style={{
            border: `1px solid ${ink}`,
            background: "transparent",
            padding: "4px 7px",
            fontSize: 15,
            lineHeight: 1,
            fontFamily: "inherit",
            cursor: "pointer",
            color: ink,
          }}
        >
          (-_-)
        </button>
      </div> */}

      {tokenModalOpen && (
        <div
          style={{
          position: "fixed",
          inset: 0,
            background: "rgba(10,10,10,0.35)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            paddingTop: 40,
            zIndex: 20,
          }}
        >
          <div
            style={{
              background: paper,
              border: `1px solid ${ink}`,
              width: "min(340px, 92vw)",
              maxHeight: "min(480px, 80vh)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ flexShrink: 0, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: `1px solid ${ink}` }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                select token to {tokenModalTarget}
              </span>
              <span onClick={() => setTokenModalOpen(false)} style={{ cursor: "pointer", fontSize: 14 }}>
                [ x ]
              </span>
            </div>

            <div style={{ flexShrink: 0, padding: "12px 16px 8px" }}>
              <input
                value={tokenSearch}
                onChange={(e) => setTokenSearch(e.target.value)}
                placeholder="search or paste address"
                className="hood-field"
                style={{
                  width: "100%",
                  border: `1px solid ${line}`,
                  outline: "none",
                  padding: "8px 10px",
                  fontSize: 12,
                  fontFamily: "inherit",
                  background: "transparent",
                  color: ink,
                }}
              />
            </div>

            {(() => {
              const mainChips = ["all", ...SUPPORTED_NETWORK_CODES];
              const restChips = liveTokens
                ? Array.from(new Set(liveTokens.map((t) => t.network.toLowerCase())))
                    .filter((n) => !SUPPORTED_NETWORK_CODES.includes(n))
                    .sort()
                : NETWORK_CHIPS.filter((n) => !mainChips.includes(n));

              const chip = (n) => (
                <span
                  key={n}
                  onClick={() => setNetworkFilter(n)}
                  style={{
                    fontSize: 11,
                    padding: "4px 8px",
                    border: `1px solid ${ink}`,
                    cursor: "pointer",
                    flexShrink: 0,
                    background: networkFilter === n ? ink : "transparent",
                    color: networkFilter === n ? paper : ink,
                  }}
                >
                  {n}
                </span>
              );

              return (
                <div style={{ flexShrink: 0, padding: "0 16px 12px", marginBottom: 4, borderBottom: `1px solid ${line}` }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {mainChips.map(chip)}
                    <span
                      onClick={() => setChainsExpanded((v) => !v)}
                      style={{
                        fontSize: 11,
                        padding: "4px 8px",
                        border: `1px solid ${line}`,
                        color: gray,
                        cursor: "pointer",
                        flexShrink: 0,
                      }}
                    >
                      {chainsExpanded ? "less ▲" : "more ▾"}
                    </span>
                  </div>
                  {chainsExpanded && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>{restChips.map(chip)}</div>
                  )}
                </div>
              );
            })()}

            {ownedOnlyTarget && (
              <div style={{ flexShrink: 0, padding: "8px 16px 6px", fontSize: 10, color: gray }}>
                {!isConnected
                  ? "connect a wallet to see the tokens you hold"
                  : ownedBalancesStatus === "loading"
                  ? "checking your wallet balances..."
                  : tokenModalShowAll
                  ? "showing all tokens"
                  : "showing only tokens held in your connected wallet"}
                {isConnected && ownedBalancesStatus !== "loading" && (
                  <span
                    onClick={() => setTokenModalShowAll((v) => !v)}
                    style={{ marginLeft: 8, cursor: "pointer", textDecoration: "underline" }}
                  >
                    {tokenModalShowAll ? "[ show only owned ]" : "[ show all tokens instead ]"}
                  </span>
                )}
              </div>
            )}

            <div
              style={{
                flexShrink: 0,
                display: "flex",
                justifyContent: "space-between",
                padding: ownedOnlyTarget ? "0 16px 6px" : "8px 16px 6px",
                fontSize: 10,
                color: gray,
              }}
            >
              <span>token</span>
              <span>{ownedOnlyTarget && isConnected && !tokenModalShowAll ? "amount / price" : "price"}</span>
            </div>

            <div style={{ flex: 1, minHeight: 0, borderTop: `1px solid ${line}`, overflowY: "auto", padding: "4px 0" }}>
              {ownedOnlyTarget && isConnected && !tokenModalShowAll
                ? (liveTokens || TOKEN_LIST)
                    .filter((t) => {
                      const bal = ownedBalances[`${t.symbol}|${t.network}`];
                      return (
                        (networkFilter === "all" || t.network.toLowerCase() === networkFilter) &&
                        t.symbol.toLowerCase().includes(tokenSearch.toLowerCase()) &&
                        bal !== undefined &&
                        bal > 0n
                      );
                    })
                    .sort((a, b) => {
                      const valueOf = (t) =>
                        Number(formatUnits(ownedBalances[`${t.symbol}|${t.network}`], t.decimals ?? 18)) * (t.price ?? 0);
                      return valueOf(b) - valueOf(a);
                    })
                    .map((t, i) => (
                      <div
                        key={i}
                        onClick={() => {
                          if (tokenModalTarget === "send") {
                            setSendTok(t.symbol);
                            setSendNetwork(t.network);
                          } else {
                            setSellTok(t.symbol);
                            setSellNetwork(t.network);
                          }
                          setTokenModalOpen(false);
                        }}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "10px 16px",
                          cursor: "pointer",
                          borderBottom: `1px solid ${line}`,
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 500 }}>{t.symbol}</div>
                          <div style={{ fontSize: 11, color: gray }}>on {t.network}</div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 13 }}>
                            {Number(formatUnits(ownedBalances[`${t.symbol}|${t.network}`], t.decimals ?? 18)).toFixed(5)}
                          </div>
                          {t.price !== undefined && (
                            <div style={{ fontSize: 11, color: gray }}>
                              $
                              {(
                                Number(formatUnits(ownedBalances[`${t.symbol}|${t.network}`], t.decimals ?? 18)) *
                                t.price
                              ).toFixed(2)}
                            </div>
                          )}
                        </div>
                      </div>
                    ))
                : (liveTokens || TOKEN_LIST)
                    .filter(
                      (t) =>
                        (networkFilter === "all" || t.network.toLowerCase() === networkFilter) &&
                        t.symbol.toLowerCase().includes(tokenSearch.toLowerCase())
                    )
                    .sort((a, b) => tokenSortRank(a) - tokenSortRank(b))
                    .map((t, i) => (
                      <div
                        key={i}
                        onClick={() => {
                          if (tokenModalTarget === "sell") {
                            setSellTok(t.symbol);
                            setSellNetwork(t.network);
                          } else if (tokenModalTarget === "send") {
                            setSendTok(t.symbol);
                            setSendNetwork(t.network);
                          } else if (tokenModalTarget === "receive") {
                            setReceiveToken(t.symbol);
                            setReceiveNetwork(t.network);
                          } else {
                            setBuyTok(t.symbol);
                            setBuyNetwork(t.network);
                          }
                          setTokenModalOpen(false);
                        }}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "10px 16px",
                          cursor: "pointer",
                          borderBottom: `1px solid ${line}`,
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 500 }}>{t.symbol}</div>
                          <div style={{ fontSize: 11, color: gray }}>on {t.network}</div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <TokenBalance token={t} gray={gray} />
                        </div>
                      </div>
                    ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Manual-deposit instructions — shown once a real (dry:false) quote comes
// back and there's no connected EVM wallet to auto-sign with. The user
// sends from wherever they like; pollSwapStatus/pollSendStatus (already
// chain-agnostic) picks it up the moment the deposit lands.
function DepositPanel({ address, amountLabel, symbol, network, deadline, timeEstimate, statusDetail, ink, gray, line, paper }) {
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(address, { width: 128, margin: 1, color: { dark: ink, light: paper } })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [address, ink, paper]);

  const copy = () => {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div style={{ marginTop: 10, border: `1px solid ${ink}`, background: paper, padding: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, border: `1px solid ${ink}`, padding: "6px 8px", marginBottom: 10 }}>
        [ ! ] only send {symbol} on the {network} network to this address — any other token or chain may be
        unrecoverable.
      </div>

      <div style={{ fontSize: 12 }}>
        send exactly <strong>{amountLabel} {symbol}</strong> on <strong>{network}</strong> to:
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginTop: 8 }}>
        {qrDataUrl && (
          <img
            src={qrDataUrl}
            alt="deposit address QR code"
            width={96}
            height={96}
            style={{ flexShrink: 0, border: `1px solid ${line}` }}
          />
        )}
        <div
          style={{
            flex: 1,
            padding: "8px 10px",
            border: `1px solid ${line}`,
            fontSize: 12,
            wordBreak: "break-all",
            alignSelf: "stretch",
          }}
        >
          {address}
        </div>
      </div>

      <div
        onClick={copy}
        style={{ marginTop: 8, fontSize: 11, cursor: "pointer", textDecoration: "underline", display: "inline-block" }}
      >
        {copied ? "[ copied ]" : "[ copy address ]"}
      </div>

      <div style={{ marginTop: 8, fontSize: 11, color: gray }}>
        {statusDetail ? STATUS_DETAIL_LABEL[statusDetail] || statusDetail : "waiting for the deposit to arrive..."}
        {timeEstimate ? ` usually settles in ~${timeEstimate}s once received.` : ""}
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: gray }}>
        this page updates automatically — no need to reconnect or refresh.
        {deadline && ` complete by ${new Date(deadline).toLocaleString()}.`}
      </div>
    </div>
  );
}

function FieldRow({ label, value, onChange, token, network, placeholder = "0", selectToken, onSelectClick, gray, line, ink, bold }) {
  return (
    <div style={{ borderBottom: `1px solid ${line}`, paddingBottom: 8, marginBottom: 4 }}>
      <div style={{ fontSize: 11, color: gray, marginBottom: 4, fontWeight: bold ? 600 : 400 }}>{label}</div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        {onChange ? (
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="hood-field"
            style={{
              border: "none",
              outline: "none",
              fontSize: 20,
              fontWeight: bold ? 600 : 400,
              fontFamily: "inherit",
              background: "transparent",
              color: ink,
              width: "60%",
            }}
          />
        ) : (
          <span style={{ fontSize: 20, fontWeight: bold ? 600 : 400, color: "#B9B6AB" }}>{placeholder}</span>
        )}
        <span
          onClick={selectToken ? onSelectClick : undefined}
          style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", cursor: selectToken ? "pointer" : "default" }}
        >
          <span style={{ fontSize: 13, borderBottom: `1px solid ${ink}`, paddingBottom: 1 }}>
            {selectToken ? (token ? token : "select token") : token}
          </span>
          {token && network && <span style={{ fontSize: 10, color: gray, marginTop: 2 }}>on {network}</span>}
        </span>
      </div>
    </div>
  );
}

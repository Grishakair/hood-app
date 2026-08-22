// Small set of pure helpers + config shared between App.jsx (swap/send) and
// Borrow.jsx (the Aave borrow aggregator). Kept in their own module rather
// than exported from App.jsx so the two feature files don't import each
// other (App renders BorrowPanel — a cycle back the other way would leave
// Borrow's top-level consts reading App's exports before they're
// initialized).
import { getAccount, switchChain } from "wagmi/actions";
import { mainnet, base, optimism, polygon, bsc, monad } from "@reown/appkit/networks";
import { wagmiConfig } from "../config/appkit.js";

export const EXPLORER_BY_CHAIN = {
  [mainnet.id]: "https://etherscan.io",
  [base.id]: "https://basescan.org",
  [optimism.id]: "https://optimistic.etherscan.io",
  [polygon.id]: "https://polygonscan.com",
  [bsc.id]: "https://bscscan.com",
  [monad.id]: "https://monadscan.com",
};

// EVM chains we can actually read live balances for via wagmi. Keyed by both
// the fallback list's names and the 1click API's short blockchain codes,
// lowercased, since the two disagree ("Ethereum" vs "eth").
export const CHAIN_ID_BY_NETWORK = {
  ethereum: mainnet.id,
  eth: mainnet.id,
  base: base.id,
  optimism: optimism.id,
  op: optimism.id,
  polygon: polygon.id,
  pol: polygon.id,
  bsc: bsc.id,
  bnb: bsc.id,
  monad: monad.id,
};

export const NATIVE_SYMBOL_BY_CHAIN = {
  [mainnet.id]: "ETH",
  [base.id]: "ETH",
  [optimism.id]: "ETH",
  [polygon.id]: "POL",
  [bsc.id]: "BNB",
  [monad.id]: "MON",
};

export const CHAIN_NAME_BY_ID = {
  [mainnet.id]: "Ethereum",
  [base.id]: "Base",
  [optimism.id]: "Optimism",
  [polygon.id]: "Polygon",
  [bsc.id]: "BNB Chain",
  [monad.id]: "Monad",
};

// Some mobile wallet connectors don't auto-switch the active chain when a
// tx is sent with a differing chainId — they just reject with a mismatch
// error instead. Ask up front so the wallet's own network-switch prompt
// (or a clear message if it can't) shows before we try to sign anything.
export async function ensureChain(chainId) {
  if (getAccount(wagmiConfig).chainId === chainId) return;
  try {
    await switchChain(wagmiConfig, { chainId });
  } catch {
    const name = CHAIN_NAME_BY_ID[chainId] || `chain ${chainId}`;
    throw new Error(`switch your wallet to ${name} and try again`);
  }
}

// Cuts (never rounds) a decimal string down to N places, so "max" amounts
// can never end up asking to spend more than the wallet actually holds.
export function truncateDecimalString(value, maxDecimals) {
  const [whole, frac = ""] = value.split(".");
  if (!frac) return whole;
  const trimmed = frac.slice(0, maxDecimals);
  return trimmed ? `${whole}.${trimmed}` : whole;
}

const AURORA_API_KEY = import.meta.env.VITE_AURORA_API_KEY;
export const AURORA_QUOTE_URL = AURORA_API_KEY ? `https://intents-api.aurora.dev/api/quote/${AURORA_API_KEY}` : null;
export const AURORA_DEPOSIT_SUBMIT_URL = AURORA_API_KEY ? `https://intents-api.aurora.dev/api/deposit/submit/${AURORA_API_KEY}` : null;
export const AURORA_STATUS_URL = AURORA_API_KEY ? `https://intents-api.aurora.dev/api/status/${AURORA_API_KEY}` : null;

// Converts a decimal amount string ("1.5") to the token's smallest-unit
// integer string, without floating-point rounding error.
export function toBaseUnits(amountStr, decimals) {
  const [whole, frac = ""] = amountStr.split(".");
  const paddedFrac = (frac + "0".repeat(decimals)).slice(0, decimals);
  const digits = `${whole}${paddedFrac}`.replace(/^0+(?=\d)/, "");
  return digits || "0";
}

export function findTokenRecord(tokens, symbol, network) {
  if (!tokens || !symbol || !network) return null;
  return tokens.find((t) => t.symbol === symbol && t.network === network) || null;
}

export const STATUS_DETAIL_LABEL = {
  KNOWN_DEPOSIT_TX: "deposit seen, waiting for confirmations...",
  PENDING_DEPOSIT: "waiting for the deposit to arrive...",
  INCOMPLETE_DEPOSIT: "deposit received is below the required amount",
  PROCESSING: "deposit confirmed — swapping now...",
};

export function buildQuoteBody({ dry, originToken, destToken, amountBaseUnits, slippageBps, recipient, refundTo, confidential }) {
  return {
    dry,
    swapType: "EXACT_INPUT",
    depositType: "ORIGIN_CHAIN",
    amount: amountBaseUnits,
    originAsset: originToken.assetId,
    destinationAsset: destToken.assetId,
    slippageTolerance: slippageBps,
    // refundTo lives on the ORIGIN chain, recipient on the DESTINATION chain —
    // only the same value when a connected EVM wallet is signing both sides.
    // Falls back to recipient for the dry-preview call site, which never had
    // a separate refund address to begin with.
    refundTo: refundTo ?? recipient,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    // Confidential Intents rails — recipient stays hidden from the
    // counterparty and onlookers. Available as of writing via "basic"/"advanced".
    confidentiality: confidential ? "basic" : "public",
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The dry-quote endpoint occasionally fails transiently — the solver
// network taking a moment, not an actual absence of a route — and without
// a retry that shows up to the user as "no route found" for a split
// second before the very next quote succeeds. Retry a couple of times
// before surfacing an error, so a live-preview blip doesn't get shown as
// if it were real.
export async function fetchQuoteWithRetry(url, body, { retries = 3, delayMs = 500, isCancelled } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (isCancelled?.()) throw new Error("cancelled");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("quote failed");
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(delayMs);
    }
  }
  throw lastErr;
}

// Surfaces the API's own reason (e.g. "Failed to get quote" when a route
// genuinely can't be filled right now) instead of a generic message, so
// a real backend/liquidity issue doesn't look like "you did something
// wrong" — the two need different next steps from the user.
export async function quoteErrorMessage(res) {
  try {
    const data = await res.json();
    if (data?.message) return data.message;
  } catch {
    // response wasn't JSON — fall through to the generic message
  }
  return "could not get a live quote";
}

// A handful of wallets/RPC endpoints surface their own flakiness as cryptic
// strings ("Version of JSON-RPC protocol is not supported", RPC calls
// returning "Unauthorized") that read like an app bug but are actually the
// connected wallet's configured node for that chain being broken — nothing
// a dApp can control, since wallets broadcast/read through their own RPC,
// not this app's. Recognized here so the fix (switch the RPC in the
// wallet's network settings) shows up instead of the raw wallet text.
const RPC_FLAKE_PATTERNS = [
  /json-rpc protocol/i,
  /unauthorized/i,
  /internal json-rpc error/i,
  /failed to fetch/i,
  /missing or invalid parameters/i,
];

export function friendlyTxError(err, fallback = "something went wrong") {
  const raw = err?.shortMessage || err?.message || fallback;
  if (!RPC_FLAKE_PATTERNS.some((p) => p.test(raw))) return raw;
  return `${raw} — this usually means your wallet's RPC endpoint for this chain is broken or unauthorized, not this app. Try switching the RPC URL for this network in your wallet's settings, then try again.`;
}

export const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
    stateMutability: "view",
  },
  {
    constant: false,
    inputs: [
      { name: "_to", type: "address" },
      { name: "_value", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
    stateMutability: "nonpayable",
  },
];

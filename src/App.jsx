import { useState, useEffect, useRef } from "react";
import { useAccount, useBalance, useChainId, useDisconnect } from "wagmi";
import { getBalance, multicall, sendTransaction, writeContract } from "wagmi/actions";
import { formatUnits } from "viem";
import { useAppKit } from "@reown/appkit/react";
import { mainnet, base, optimism, polygon } from "@reown/appkit/networks";
import { wagmiConfig } from "./config/appkit.js";

const EXPLORER_BY_CHAIN = {
  [mainnet.id]: "https://etherscan.io",
  [base.id]: "https://basescan.org",
  [optimism.id]: "https://optimistic.etherscan.io",
  [polygon.id]: "https://polygonscan.com",
};

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

// EVM chains we can actually read live balances for via wagmi. Keyed by both
// the fallback list's names and the 1click API's short blockchain codes,
// lowercased, since the two disagree ("Ethereum" vs "eth").
const CHAIN_ID_BY_NETWORK = {
  ethereum: mainnet.id,
  eth: mainnet.id,
  base: base.id,
  optimism: optimism.id,
  op: optimism.id,
  polygon: polygon.id,
  pol: polygon.id,
};

// Shown first in the network filter chips — the chains wallet connect,
// balances, and swap execution actually work on.
const SUPPORTED_NETWORK_CODES = ["eth", "base", "op", "pol"];

const NATIVE_SYMBOL_BY_CHAIN = {
  [mainnet.id]: "ETH",
  [base.id]: "ETH",
  [optimism.id]: "ETH",
  [polygon.id]: "POL",
};

// "max" on a native token must leave room for gas — a conservative fixed
// buffer rather than a live estimate, in the token's own units.
const GAS_RESERVE_NATIVE = {
  [mainnet.id]: 0.002,
  [base.id]: 0.0005,
  [optimism.id]: 0.0005,
  [polygon.id]: 0.05,
};

const isEvmAddress = (value) => /^0x[a-fA-F0-9]{40}$/.test(value || "");

// Cuts (never rounds) a decimal string down to N places, so "max" amounts
// can never end up asking to spend more than the wallet actually holds.
function truncateDecimalString(value, maxDecimals) {
  const [whole, frac = ""] = value.split(".");
  if (!frac) return whole;
  const trimmed = frac.slice(0, maxDecimals);
  return trimmed ? `${whole}.${trimmed}` : whole;
}

const AURORA_API_KEY = import.meta.env.VITE_AURORA_API_KEY;
const AURORA_QUOTE_URL = AURORA_API_KEY ? `https://intents-api.aurora.dev/api/quote/${AURORA_API_KEY}` : null;
const AURORA_DEPOSIT_SUBMIT_URL = AURORA_API_KEY ? `https://intents-api.aurora.dev/api/deposit/submit/${AURORA_API_KEY}` : null;
const AURORA_STATUS_URL = AURORA_API_KEY ? `https://intents-api.aurora.dev/api/status/${AURORA_API_KEY}` : null;

// Converts a decimal amount string ("1.5") to the token's smallest-unit
// integer string, without floating-point rounding error.
function toBaseUnits(amountStr, decimals) {
  const [whole, frac = ""] = amountStr.split(".");
  const paddedFrac = (frac + "0".repeat(decimals)).slice(0, decimals);
  const digits = `${whole}${paddedFrac}`.replace(/^0+(?=\d)/, "");
  return digits || "0";
}

function findTokenRecord(tokens, symbol, network) {
  if (!tokens || !symbol || !network) return null;
  return tokens.find((t) => t.symbol === symbol && t.network === network) || null;
}

const STATUS_DETAIL_LABEL = {
  KNOWN_DEPOSIT_TX: "deposit seen, waiting for confirmations...",
  PENDING_DEPOSIT: "waiting for the deposit to arrive...",
  INCOMPLETE_DEPOSIT: "deposit received is below the required amount",
  PROCESSING: "deposit confirmed — swapping now...",
};

function buildQuoteBody({ dry, originToken, destToken, amountBaseUnits, slippageBps, recipient, confidential }) {
  return {
    dry,
    swapType: "EXACT_INPUT",
    depositType: "ORIGIN_CHAIN",
    amount: amountBaseUnits,
    originAsset: originToken.assetId,
    destinationAsset: destToken.assetId,
    slippageTolerance: slippageBps,
    refundTo: recipient,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    // Confidential Intents rails — recipient stays hidden from the
    // counterparty and onlookers. Available as of writing via "basic"/"advanced".
    confidentiality: confidential ? "basic" : "public",
  };
}

// balanceOf (read) + transfer (deposit funding) in one ABI.
const ERC20_ABI = [
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
    <svg width={size} height={size * (178 / 160)} viewBox="0 0 160 178" style={{ display: "block" }}>
      <path
        d="M80 16C124 16 150 44.3224 150 80.1975V110.408C150 148.171 116 144.395 80 144.395C44 144.395 10 148.171 10 110.408V80.1975C10 44.3224 36 16 80 16Z"
        fill={ink}
      />
      <path
        d="M58 90C65.732 90 72 83.732 72 76C72 68.268 65.732 62 58 62C50.268 62 44 68.268 44 76C44 83.732 50.268 90 58 90Z"
        fill={paper}
      />
      <path
        d="M102 90C109.732 90 116 83.732 116 76C116 68.268 109.732 62 102 62C94.268 62 88 68.268 88 76C88 83.732 94.268 90 102 90Z"
        fill={paper}
      />
      <path
        d="M58 81.5C61.0376 81.5 63.5 79.0376 63.5 76C63.5 72.9624 61.0376 70.5 58 70.5C54.9624 70.5 52.5 72.9624 52.5 76C52.5 79.0376 54.9624 81.5 58 81.5Z"
        fill={ink}
      />
      <path
        d="M102 81.5C105.038 81.5 107.5 79.0376 107.5 76C107.5 72.9624 105.038 70.5 102 70.5C98.9624 70.5 96.5 72.9624 96.5 76C96.5 79.0376 98.9624 81.5 102 81.5Z"
        fill={ink}
      />
    </svg>
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
            {balance ? `${Number(balance.formatted).toFixed(4)} ETH` : "..."}
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
  const [mode, setMode] = useState("swap");
  const [priv, setPriv] = useState(false);
  const [sellAmt, setSellAmt] = useState("");
  const [sellTok, setSellTok] = useState("ETH");
  const [sellNetwork, setSellNetwork] = useState("eth");
  const [buyTok, setBuyTok] = useState(null);
  const [buyNetwork, setBuyNetwork] = useState(null);
  const [buyAmount, setBuyAmount] = useState("");
  const [quoteStatus, setQuoteStatus] = useState("idle"); // idle | loading | ok | error
  const [swapStatus, setSwapStatus] = useState("idle"); // idle | quoting | awaiting-signature | pending-deposit | processing | success | failed | refunded | error
  const [swapError, setSwapError] = useState("");
  const [swapTxHash, setSwapTxHash] = useState("");
  // Unlike swapTxHash (cleared whenever the trade form changes), this is a
  // persistent receipt of the last broadcast deposit — kept around so it
  // doesn't vanish the moment you start setting up the next swap.
  const [lastTxHash, setLastTxHash] = useState("");
  const [lastTxChainId, setLastTxChainId] = useState(null);
  const [swapStatusDetail, setSwapStatusDetail] = useState("");
  const swapPollToken = useRef(0);
  const [recipient, setRecipient] = useState("");
  const [sendAmt, setSendAmt] = useState("");
  const [sendTok, setSendTok] = useState("ETH");
  const [sendNetwork, setSendNetwork] = useState("eth");
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
    if (mode !== "swap" || !AURORA_QUOTE_URL) return;

    const originToken = findTokenRecord(liveTokens, sellTok, sellNetwork);
    const destToken = findTokenRecord(liveTokens, buyTok, buyNetwork);
    const amountNum = Number(sellAmt);

    if (!originToken?.assetId || !destToken?.assetId || !amountNum || amountNum <= 0) {
      setBuyAmount("");
      setQuoteStatus("idle");
      return;
    }

    let cancelled = false;
    setQuoteStatus("loading");
    const refundRecipient = isConnected && address ? address : "0x0000000000000000000000000000000000000000";
    const slippageBps = Math.round(Number(customSlippage || slippage) * 100);

    const timeout = setTimeout(() => {
      fetch(AURORA_QUOTE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildQuoteBody({
            dry: true,
            originToken,
            destToken,
            amountBaseUnits: toBaseUnits(sellAmt, originToken.decimals),
            slippageBps,
            recipient: refundRecipient,
            confidential: swapPriv,
          })
        ),
      })
        .then((res) => {
          if (!res.ok) throw new Error("quote failed");
          return res.json();
        })
        .then((data) => {
          if (cancelled) return;
          setBuyAmount(data.quote.amountOutFormatted);
          setQuoteStatus("ok");
        })
        .catch(() => {
          if (!cancelled) {
            setBuyAmount("");
            setQuoteStatus("error");
          }
        });
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [mode, sellAmt, sellTok, sellNetwork, buyTok, buyNetwork, liveTokens, slippage, customSlippage, isConnected, address, swapPriv]);

  // A previous attempt's result no longer applies once the trade itself changes.
  useEffect(() => {
    setSwapStatus("idle");
    setSwapError("");
    setSwapTxHash("");
    setSwapStatusDetail("");
  }, [sellAmt, sellTok, sellNetwork, buyTok, buyNetwork, swapPriv]);

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
            setSwapStatus("processing");
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
    if (!isConnected || !address) {
      open();
      return;
    }
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
    if (!chainId) {
      setSwapStatus("error");
      setSwapError("this origin network isn't supported by the connected wallet yet");
      return;
    }

    const finalRecipient = swapRecipient || address;
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
            confidential: swapPriv,
          })
        ),
      });
      if (!res.ok) throw new Error("could not get a live quote");
      const quoteData = await res.json();
      const depositAddress = quoteData.quote?.depositAddress;
      if (!depositAddress) throw new Error("no deposit address returned");

      setSwapStatus("awaiting-signature");

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

  const swapBusy = ["quoting", "awaiting-signature", "pending-deposit", "processing"].includes(swapStatus);
  const swapButtonLabel =
    mode !== "swap"
      ? priv
        ? "send privately"
        : "send"
      : {
          quoting: "getting live quote...",
          "awaiting-signature": "confirm in wallet...",
          "pending-deposit": "sending deposit...",
          processing: "processing swap...",
          success: "swap complete — do another",
          failed: "swap failed — try again",
          refunded: "refunded — try again",
          error: "try again",
        }[swapStatus] ||
        (!isConnected ? "connect wallet" : swapPriv ? "review private swap" : "review swap");

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
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap');
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
      `}</style>

      {/* header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 0 32px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }} onClick={() => setTopTab("app")}>
          <HoodMark size={28} ink={ink} paper={paper} />
          <div style={{ fontSize: 20, letterSpacing: 2, fontWeight: 500 }}>Hood</div>
        </div>

        <div style={{ display: "flex", gap: 20, fontSize: 13 }}>
          {[
            { key: "app", label: "Swap" },
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
        <div style={{ maxWidth: 380, margin: "0 auto", border: `1px solid ${ink}`, background: paper, padding: 24, textAlign: "center", fontSize: 13, color: gray }}>
          content coming soon
        </div>
      )}

      {topTab === "club" && (
        <div style={{ maxWidth: 380, margin: "0 auto", border: `1px solid ${ink}`, background: paper, padding: 24, textAlign: "center", fontSize: 13, color: gray }}>
          content coming soon
        </div>
      )}

      {topTab === "app" && (
      <>
      {/* card */}
      <div style={{ maxWidth: 380, margin: "0 auto", border: `1px solid ${ink}`, background: paper }}>
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
                selectToken
                onSelectClick={() => {
                  setTokenModalTarget("sell");
                  setTokenModalOpen(true);
                }}
                gray={gray}
                line={line}
                ink={ink}
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
              <div style={{ textAlign: "center", fontSize: 12, color: gray, margin: "6px 0" }}>v</div>
              <FieldRow
                label="buy"
                value=""
                placeholder={quoteStatus === "loading" ? "..." : buyAmount || "0"}
                token={buyTok}
                selectToken
                onSelectClick={() => {
                  setTokenModalTarget("buy");
                  setTokenModalOpen(true);
                }}
                gray={gray}
                line={line}
                ink={ink}
              />
              {quoteStatus === "error" && (
                <div style={{ fontSize: 11, color: gray, marginTop: 2 }}>no route found for this pair</div>
              )}

              <div style={{ marginTop: 12, marginBottom: 4 }}>
                <div style={{ fontSize: 11, color: gray, marginBottom: 4 }}>recipient wallet (optional)</div>
                <input
                  value={swapRecipient}
                  onChange={(e) => setSwapRecipient(e.target.value)}
                  placeholder="defaults to your own wallet"
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
            onClick={mode === "swap" ? handleSwap : undefined}
            disabled={mode === "swap" && swapBusy}
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
              cursor: mode === "swap" && swapBusy ? "default" : "pointer",
              opacity: mode === "swap" && swapBusy ? 0.6 : 1,
            }}
          >
            {swapButtonLabel}
          </button>

          {mode === "swap" && swapStatus !== "idle" && (
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
        </div>
      </div>
      </>
      )}

      <div style={{ textAlign: "center", marginTop: 22, fontSize: 11, color: gray }}>
        powered by near intents
      </div>

      <div style={{ position: "fixed", left: 20, bottom: 20, display: "flex", alignItems: "flex-end", gap: 8, zIndex: 10 }}>
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
              width: 340,
              maxHeight: 480,
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

            <div style={{ flexShrink: 0, padding: "8px 16px 0", fontSize: 10, color: gray }}>
              {liveTokensStatus === "loading" && "fetching live token list..."}
              {liveTokensStatus === "live" && `live from 1click api — ${liveTokens.length} tokens`}
              {liveTokensStatus === "offline" && "offline — showing demo data"}
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
                  : "showing only tokens held in your connected wallet"}
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
              <span>{ownedOnlyTarget && isConnected ? "amount / price" : "price"}</span>
            </div>

            <div style={{ flex: 1, minHeight: 0, borderTop: `1px solid ${line}`, overflowY: "auto", padding: "4px 0" }}>
              {ownedOnlyTarget && isConnected
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

function FieldRow({ label, value, onChange, token, placeholder = "0", selectToken, onSelectClick, gray, line, ink, bold }) {
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
              fontFamily: "inherit",
              background: "transparent",
              color: ink,
              width: "60%",
            }}
          />
        ) : (
          <span style={{ fontSize: 20, color: "#B9B6AB" }}>{placeholder}</span>
        )}
        <span
          onClick={selectToken ? onSelectClick : undefined}
          style={{
            fontSize: 13,
            borderBottom: `1px solid ${ink}`,
            paddingBottom: 1,
            cursor: selectToken ? "pointer" : "default",
          }}
        >
          {selectToken ? (token ? token : "select token") : token}
        </span>
      </div>
    </div>
  );
}

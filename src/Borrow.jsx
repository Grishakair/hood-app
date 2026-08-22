import { useEffect, useState } from "react";
import { writeContract, sendTransaction, waitForTransactionReceipt, readContract } from "wagmi/actions";
import { formatUnits } from "viem";
import { mainnet, base, bsc, polygon, monad } from "@reown/appkit/networks";
import { wagmiConfig } from "./config/appkit.js";
import {
  EXPLORER_BY_CHAIN,
  CHAIN_ID_BY_NETWORK,
  NATIVE_SYMBOL_BY_CHAIN,
  ensureChain,
  truncateDecimalString,
  toBaseUnits,
  findTokenRecord,
  AURORA_QUOTE_URL,
  AURORA_STATUS_URL,
  AURORA_DEPOSIT_SUBMIT_URL,
  buildQuoteBody,
  quoteErrorMessage,
  friendlyTxError,
  STATUS_DETAIL_LABEL,
  ERC20_ABI,
} from "./lib/shared.js";

const AAVE_GRAPHQL_URL = "https://api.v3.aave.com/graphql";

// The four chains Hood's swap/send flows already treat as first-class (see
// SUPPORTED_NETWORK_CODES in App.jsx) — all four also have a live Aave v3
// deployment, so the same set works here without adding new chain support.
// Monad is the odd one out (borrowMode "stable" below) — Aave v3.7 went
// live there in July 2026 as a real deployment, not a fork, so it reads
// through the exact same GraphQL + Pool ABI as everywhere else.
const AAVE_CHAINS = [
  { network: "eth", label: "Ethereum", chain: mainnet, borrowMode: "eth" },
  { network: "base", label: "Base", chain: base, borrowMode: "eth" },
  { network: "bsc", label: "BNB Chain", chain: bsc, borrowMode: "eth" },
  { network: "pol", label: "Polygon", chain: polygon, borrowMode: "eth" },
  { network: "monad", label: "Monad", chain: monad, borrowMode: "stable" },
];
const CHAIN_LABEL = Object.fromEntries(AAVE_CHAINS.map((c) => [c.network, c.label]));
const BORROW_MODE_BY_NETWORK = Object.fromEntries(AAVE_CHAINS.map((c) => [c.network, c.borrowMode]));

// Aave lists ETH exposure as "WETH" on most chains but as bridged "ETH" on
// BNB Chain — check both when looking for the borrowable reserve.
const BORROW_SYMBOLS = ["WETH", "ETH"];

// Monad's Aave market has no ETH reserve with borrowing enabled — the whole
// point there is a same-asset-class carry (supply USDC, borrow a cheaper
// stablecoin) rather than a directional ETH position, so "cheapest enabled
// stablecoin that isn't the collateral itself" is the actual borrow target,
// not a fixed symbol.
const STABLE_BORROW_SYMBOLS = ["GHO", "USDT0", "USDT", "AUSD", "USDe", "mUSD", "DAI"];

const APPROVE_ABI = [
  {
    constant: false,
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
    stateMutability: "nonpayable",
  },
];

// Only the two Pool functions this demo needs — stable across Aave v3
// deployments, so no per-chain ABI variance to worry about.
const AAVE_POOL_ABI = [
  {
    name: "supply",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    name: "borrow",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [],
  },
];

// Queries Aave's own GraphQL API (api.v3.aave.com/graphql, public/no-key)
// live — this is the actual rate aggregation, not a cached/hardcoded table.
async function fetchAaveRates() {
  const chainIds = AAVE_CHAINS.map((c) => c.chain.id).join(",");
  const query = `{ markets(request: { chainIds: [${chainIds}] }) { address chain { chainId } reserves { underlyingToken { symbol address decimals } usdExchangeRate supplyInfo { canBeCollateral maxLTV { value } } borrowInfo { apy { formatted } borrowingState availableLiquidity { amount { value } } } } } }`;

  const res = await fetch(AAVE_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error("could not reach Aave's API");
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  const markets = json.data.markets;

  return AAVE_CHAINS.map(({ network, label, chain, borrowMode }) => {
    // Some chains (Ethereum especially) list several markets — Core plus
    // specialized ones like Prime/EtherFi/Lido that only carry a subset of
    // reserves. Picking markets[0] for the chain would silently lock onto
    // whichever pool the API happens to return first, which may not have
    // USDC collateral or an ETH reserve at all — so find the market that
    // actually has both, not just the first one for this chainId.
    const chainMarkets = markets.filter((m) => m.chain.chainId === chain.id);

    // "eth" mode: find the (single) WETH/ETH reserve. "stable" mode: among
    // enabled stablecoin reserves that aren't the USDC collateral itself,
    // pick whichever has the lowest borrow APY — that's the one that
    // maximizes the supply/borrow spread, i.e. the actual carry.
    const findBorrow = (reserves, collateralSymbol) =>
      borrowMode === "stable"
        ? reserves
            .filter(
              (r) =>
                r.underlyingToken.symbol !== collateralSymbol &&
                STABLE_BORROW_SYMBOLS.includes(r.underlyingToken.symbol) &&
                r.borrowInfo?.borrowingState === "ENABLED" &&
                Number(r.borrowInfo?.availableLiquidity?.amount?.value) > 0
            )
            .sort((a, b) => Number(a.borrowInfo.apy.formatted) - Number(b.borrowInfo.apy.formatted))[0]
        : reserves.find((r) => BORROW_SYMBOLS.includes(r.underlyingToken.symbol));

    let market, collateral, borrow;
    for (const m of chainMarkets) {
      const c = m.reserves.find((r) => r.underlyingToken.symbol === "USDC" && r.supplyInfo.canBeCollateral);
      const b = c ? findBorrow(m.reserves, c.underlyingToken.symbol) : undefined;
      if (c && b) {
        market = m;
        collateral = c;
        borrow = b;
        break;
      }
    }
    // No market has both — fall back to the first one just to report *why*
    // (still lets "no USDC market" vs "no ETH market" distinguish correctly).
    if (!market) {
      market = chainMarkets[0];
      collateral = market?.reserves.find((r) => r.underlyingToken.symbol === "USDC" && r.supplyInfo.canBeCollateral);
      borrow = collateral ? findBorrow(market.reserves, collateral.underlyingToken.symbol) : undefined;
    }
    const eligible = Boolean(collateral && borrow && borrow.borrowInfo?.borrowingState === "ENABLED");

    return {
      network,
      label,
      chainId: chain.id,
      eligible,
      reason: !market
        ? "no market"
        : !collateral
        ? "no USDC market"
        : !borrow
        ? borrowMode === "stable"
          ? "no stablecoin to borrow"
          : "no ETH market"
        : "borrowing disabled",
      poolAddress: market?.address,
      borrowApy: eligible ? Number(borrow.borrowInfo.apy.formatted) : null,
      liquidity: eligible ? Number(borrow.borrowInfo.availableLiquidity.amount.value) : null,
      collateralAsset: collateral
        ? {
            address: collateral.underlyingToken.address,
            decimals: collateral.underlyingToken.decimals,
            usdPrice: Number(collateral.usdExchangeRate),
            maxLtv: Number(collateral.supplyInfo.maxLTV.value),
          }
        : null,
      borrowAsset: borrow
        ? {
            address: borrow.underlyingToken.address,
            decimals: borrow.underlyingToken.decimals,
            symbol: borrow.underlyingToken.symbol,
            usdPrice: Number(borrow.usdExchangeRate),
          }
        : null,
    };
  });
}

// Polls the same Aurora intents status endpoint the swap/send flows use,
// until the bridge leg settles — resolves on SUCCESS, rejects on
// FAILED/REFUNDED, otherwise reports the in-between state and keeps polling.
function pollUntilSettled(depositAddress, onDetail) {
  return new Promise((resolve, reject) => {
    const check = () => {
      fetch(`${AURORA_STATUS_URL}?depositAddress=${depositAddress}`)
        .then((res) => {
          if (!res.ok) throw new Error("status check failed");
          return res.json();
        })
        .then((data) => {
          if (data.status === "SUCCESS") return resolve();
          if (data.status === "FAILED" || data.status === "REFUNDED") {
            return reject(new Error(`bridge ${data.status.toLowerCase()}`));
          }
          onDetail(data.status);
          setTimeout(check, 3000);
        })
        .catch(() => setTimeout(check, 5000));
    };
    check();
  });
}

export default function BorrowPanel({
  ink,
  gray,
  line,
  paper,
  liveTokens,
  ownedBalances,
  ownedBalancesStatus,
  isConnected,
  address,
  open,
}) {
  // Defaults to USDC — the fast path — but any token the wallet holds on
  // any EVM chain we can sign for is a valid collateral input; Intents
  // Connect swaps+delivers it as USDC on the Aave chain in the same step.
  const [collateralToken, setCollateralToken] = useState({ symbol: "USDC", network: "base" });
  const [collateralTouched, setCollateralTouched] = useState(false);
  const [collateralAmount, setCollateralAmount] = useState("");
  const [tokenPickerOpen, setTokenPickerOpen] = useState(false);
  const [tokenSearch, setTokenSearch] = useState("");
  const [borrowAmount, setBorrowAmount] = useState("");
  const [privateBridge, setPrivateBridge] = useState(false);

  const [selectedNetwork, setSelectedNetwork] = useState(null);
  const [networkTouched, setNetworkTouched] = useState(false);
  const [receiveNetwork, setReceiveNetwork] = useState(null);
  const [rates, setRates] = useState(null);
  const [ratesStatus, setRatesStatus] = useState("loading"); // loading | ready | error
  const [ratesError, setRatesError] = useState("");

  const [runStatus, setRunStatus] = useState("idle"); // idle | running | success | error
  const [runLog, setRunLog] = useState([]);
  const [runError, setRunError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setRatesStatus("loading");
    fetchAaveRates()
      .then((data) => {
        if (cancelled) return;
        setRates(data);
        setRatesStatus("ready");
        if (!networkTouched) {
          const best = data.filter((r) => r.eligible).sort((a, b) => a.borrowApy - b.borrowApy)[0];
          if (best) setSelectedNetwork(best.network);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setRatesStatus("error");
        setRatesError(err?.message || "failed to load Aave rates");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Defaults collateral to whichever chain already holds the most USDC —
  // but only until the user picks a chain chip (or a different token)
  // themselves.
  useEffect(() => {
    if (collateralTouched || ownedBalancesStatus !== "ready") return;
    let best = null;
    let bestVal = -1n;
    for (const { network } of AAVE_CHAINS) {
      const bal = ownedBalances[`USDC|${network}`];
      if (bal !== undefined && bal > bestVal) {
        bestVal = bal;
        best = network;
      }
    }
    if (best) setCollateralToken({ symbol: "USDC", network: best });
  }, [ownedBalances, ownedBalancesStatus, collateralTouched]);

  // A previous attempt's progress only stays valid for resuming ("try
  // again" after a mid-flow failure) as long as the trade itself hasn't
  // changed — once any input does, that run log no longer describes what
  // this button click would actually do.
  useEffect(() => {
    setRunStatus("idle");
    setRunError("");
    setRunLog([]);
  }, [collateralAmount, collateralToken.symbol, collateralToken.network, borrowAmount, selectedNetwork, receiveNetwork]);

  const collateralTokenRecord = findTokenRecord(liveTokens, collateralToken.symbol, collateralToken.network);
  const collateralBalanceRaw = ownedBalances[`${collateralToken.symbol}|${collateralToken.network}`];
  const collateralDecimals = collateralTokenRecord?.decimals ?? 6;
  const collateralBalanceFormatted =
    isConnected && collateralBalanceRaw !== undefined
      ? truncateDecimalString(formatUnits(collateralBalanceRaw, collateralDecimals), 6)
      : null;

  function fillCollateral(fraction) {
    if (collateralBalanceRaw === undefined) return;
    const usable = fraction === 1 ? collateralBalanceRaw : collateralBalanceRaw / 2n;
    setCollateralAmount(truncateDecimalString(formatUnits(usable, collateralDecimals), collateralDecimals));
  }

  const eligibleRates = (rates || []).filter((r) => r.eligible);
  const bestNetwork = eligibleRates.length ? [...eligibleRates].sort((a, b) => a.borrowApy - b.borrowApy)[0].network : null;
  const activeNetwork = selectedNetwork || bestNetwork;
  const activeRate = (rates || []).find((r) => r.network === activeNetwork) || null;
  // Not just "cross-chain" any more — depositing anything other than USDC
  // already-on-the-Aave-chain needs an Intents Connect swap+delivery leg
  // first, same-chain-different-asset included.
  const needsSwap = Boolean(
    activeRate?.eligible && (collateralToken.symbol !== "USDC" || collateralToken.network !== activeNetwork)
  );
  const borrowSymbol = activeRate?.borrowAsset?.symbol || "ETH";
  const insufficientLiquidity = Boolean(
    activeRate?.eligible && borrowAmount && Number(borrowAmount) > 0 && Number(borrowAmount) > activeRate.liquidity
  );

  // How much of the borrow asset this collateral actually supports, straight
  // from Aave's own max LTV + live USD prices — not a guess. Uses the
  // collateral token's own live price (from the 1click list) rather than
  // assuming it's USDC, since the deposit might be swapped from anything.
  // A 15% haircut off the true max keeps some room below the liquidation
  // threshold (interest accrues, prices move, and a swap has slippage)
  // rather than handing back a number that's one bad tick from getting
  // liquidated.
  const collateralAmountNum = Number(collateralAmount) || 0;
  const collateralUsdValue = collateralAmountNum * (collateralTokenRecord?.price ?? 0);
  const maxBorrowAmount =
    activeRate?.eligible && collateralUsdValue > 0
      ? (collateralUsdValue * activeRate.collateralAsset.maxLtv) / activeRate.borrowAsset.usdPrice
      : null;
  const safeBorrowAmount = maxBorrowAmount !== null ? maxBorrowAmount * 0.85 : null;
  const overMaxLtv = Boolean(maxBorrowAmount !== null && borrowAmount && Number(borrowAmount) > maxBorrowAmount);

  // Owned-token options for the "deposit a different token" picker — any
  // EVM-chain token this wallet actually holds, ranked by USD value so the
  // biggest bag surfaces first. Restricted to chains we can sign a tx on
  // (CHAIN_ID_BY_NETWORK) since this flow always self-executes, unlike
  // Swap's manual-deposit fallback.
  const ownedTokenOptions = (liveTokens || [])
    .filter((t) => CHAIN_ID_BY_NETWORK[t.network?.toLowerCase()])
    .map((t) => {
      const bal = ownedBalances[`${t.symbol}|${t.network}`];
      if (bal === undefined || bal <= 0n) return null;
      const amountNum = Number(formatUnits(bal, t.decimals ?? 18));
      return { symbol: t.symbol, network: t.network, amountNum, usdValue: amountNum * (t.price || 0) };
    })
    .filter(Boolean)
    .filter((t) => !tokenSearch || t.symbol.toLowerCase().includes(tokenSearch.toLowerCase()))
    .sort((a, b) => b.usdValue - a.usdValue)
    .slice(0, 20);

  // borrow() always pays out on the chain you borrowed on — moving it
  // elsewhere afterward is a second, separate bridge leg, only possible
  // when the borrowed reserve itself has a known intents asset mapping on
  // that chain (BNB Chain's bridged "ETH" reserve currently doesn't).
  const deliverOriginToken = activeRate?.eligible ? findTokenRecord(liveTokens, activeRate.borrowAsset.symbol, activeNetwork) : null;
  const canDeliverElsewhere = Boolean(deliverOriginToken?.assetId);
  const receiveNetworkEffective = canDeliverElsewhere && receiveNetwork ? receiveNetwork : activeNetwork;
  const deliversElsewhere = Boolean(activeRate?.eligible && canDeliverElsewhere && receiveNetworkEffective !== activeNetwork);

  function setStep(key, status, extra) {
    setRunLog((log) => log.map((s) => (s.key === key ? { ...s, status, ...extra } : s)));
  }

  async function handleBorrow() {
    if (!isConnected) {
      open();
      return;
    }
    if (!activeRate?.eligible) {
      setRunStatus("error");
      setRunError("pick a chain with borrowing enabled");
      return;
    }
    if (!collateralAmount || Number(collateralAmount) <= 0) {
      setRunStatus("error");
      setRunError("enter a collateral amount");
      return;
    }
    if (!borrowAmount || Number(borrowAmount) <= 0) {
      setRunStatus("error");
      setRunError("enter an amount to borrow");
      return;
    }

    const originNetwork = collateralToken.network;
    const destNetwork = activeNetwork;
    const originChainId = CHAIN_ID_BY_NETWORK[originNetwork];
    const destChainId = CHAIN_ID_BY_NETWORK[destNetwork];
    const { poolAddress, collateralAsset, borrowAsset } = activeRate;
    // Snapshot now — the receive-chain picker could change while signatures
    // are still pending, and the deliver leg must act on what was chosen.
    const willDeliverElsewhere = deliversElsewhere;
    const deliverNetwork = receiveNetworkEffective;

    // "try again" after a mid-flow failure must resume, not restart — the
    // swap/bridge leg already moved real funds, and supply() empties the
    // wallet it drew from, so blindly re-running every step would either
    // double-spend the bridge or revert on an already-drained balance. The
    // inputs haven't changed since (see the reset effect below), so a step
    // marked "done" in the previous attempt is still valid now.
    // Only resume off a prior FAILURE — if the last run finished
    // successfully, "borrow again" with the same inputs means do it again
    // from scratch, not silently no-op because every step already reads "done".
    const wasDone = (key) => runStatus === "error" && runLog.find((s) => s.key === key)?.status === "done";
    const alreadyBridged = needsSwap && wasDone("bridge");
    const alreadySupplied = wasDone("supply");
    const alreadyBorrowed = wasDone("borrow");

    const bridgeLabel =
      collateralToken.symbol === "USDC"
        ? `bridge USDC → ${CHAIN_LABEL[destNetwork] || destNetwork}`
        : `swap ${collateralToken.symbol} → USDC on ${CHAIN_LABEL[destNetwork] || destNetwork}`;
    const steps = [
      ...(needsSwap ? [{ key: "bridge", label: bridgeLabel, status: alreadyBridged ? "done" : "pending" }] : []),
      { key: "approve", label: "approve USDC", status: alreadySupplied ? "done" : "pending" },
      { key: "supply", label: "supply USDC to Aave", status: alreadySupplied ? "done" : "pending" },
      { key: "borrow", label: `borrow ${borrowAsset.symbol}`, status: alreadyBorrowed ? "done" : "pending" },
      ...(willDeliverElsewhere ? [{ key: "deliver", label: `send ${borrowAsset.symbol} → ${CHAIN_LABEL[deliverNetwork]}`, status: "pending" }] : []),
    ];
    setRunLog(steps);
    setRunError("");
    setRunStatus("running");

    try {
      let supplyAmountBaseUnits;
      const borrowAmountBaseUnits = BigInt(toBaseUnits(borrowAmount, borrowAsset.decimals));

      if (alreadySupplied) {
        await ensureChain(destChainId);
      } else if (needsSwap && alreadyBridged) {
        await ensureChain(destChainId);
        supplyAmountBaseUnits = await readContract(wagmiConfig, {
          chainId: destChainId,
          address: collateralAsset.address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        });
      } else if (needsSwap) {
        setStep("bridge", "active", { detail: "getting a live quote..." });
        const originToken = collateralTokenRecord;
        const destToken = findTokenRecord(liveTokens, "USDC", destNetwork);
        if (!originToken?.assetId || !destToken?.assetId) {
          throw new Error("token data is still loading — try again in a moment");
        }

        const amountBaseUnits = toBaseUnits(collateralAmount, originToken.decimals);
        const res = await fetch(AURORA_QUOTE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            buildQuoteBody({
              dry: false,
              originToken,
              destToken,
              amountBaseUnits,
              slippageBps: 50,
              recipient: address,
              refundTo: address,
              confidential: privateBridge,
            })
          ),
        });
        if (!res.ok) throw new Error(await quoteErrorMessage(res));
        const quoteData = await res.json();
        const depositAddress = quoteData.quote?.depositAddress;
        if (!depositAddress) throw new Error("no deposit address returned");

        setStep("bridge", "active", { detail: "confirm the deposit in your wallet..." });
        await ensureChain(originChainId);
        const originIsNative = NATIVE_SYMBOL_BY_CHAIN[originChainId] === originToken.symbol;
        const txHash = originIsNative
          ? await sendTransaction(wagmiConfig, { chainId: originChainId, to: depositAddress, value: BigInt(amountBaseUnits) })
          : await writeContract(wagmiConfig, {
              chainId: originChainId,
              address: originToken.contractAddress,
              abi: ERC20_ABI,
              functionName: "transfer",
              args: [depositAddress, BigInt(amountBaseUnits)],
            });
        setStep("bridge", "active", { detail: "deposit sent — waiting for the bridge...", txHash, chainId: originChainId });
        await waitForTransactionReceipt(wagmiConfig, { chainId: originChainId, hash: txHash });

        if (AURORA_DEPOSIT_SUBMIT_URL) {
          fetch(AURORA_DEPOSIT_SUBMIT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ txHash, depositAddress }),
          }).catch(() => {});
        }

        await pollUntilSettled(depositAddress, (detail) =>
          setStep("bridge", "active", { detail: STATUS_DETAIL_LABEL[detail] || detail, txHash, chainId: originChainId })
        );
        setStep("bridge", "done", { txHash, chainId: originChainId });

        await ensureChain(destChainId);
        // Bridge fees mean the amount that lands is slightly less than what
        // was sent — read the real balance rather than trust the estimate,
        // so the supply call never asks for more than actually arrived.
        supplyAmountBaseUnits = await readContract(wagmiConfig, {
          chainId: destChainId,
          address: collateralAsset.address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        });
      } else {
        await ensureChain(destChainId);
        supplyAmountBaseUnits = BigInt(toBaseUnits(collateralAmount, collateralAsset.decimals));
      }

      if (!alreadySupplied) {
        setStep("approve", "active");
        const approveTx = await writeContract(wagmiConfig, {
          chainId: destChainId,
          address: collateralAsset.address,
          abi: APPROVE_ABI,
          functionName: "approve",
          args: [poolAddress, supplyAmountBaseUnits],
        });
        await waitForTransactionReceipt(wagmiConfig, { chainId: destChainId, hash: approveTx });
        setStep("approve", "done", { txHash: approveTx, chainId: destChainId });

        setStep("supply", "active");
        const supplyTx = await writeContract(wagmiConfig, {
          chainId: destChainId,
          address: poolAddress,
          abi: AAVE_POOL_ABI,
          functionName: "supply",
          args: [collateralAsset.address, supplyAmountBaseUnits, address, 0],
        });
        await waitForTransactionReceipt(wagmiConfig, { chainId: destChainId, hash: supplyTx });
        setStep("supply", "done", {
          txHash: supplyTx,
          chainId: destChainId,
          detail: `supplied ${truncateDecimalString(formatUnits(supplyAmountBaseUnits, collateralAsset.decimals), 6)} USDC`,
        });
      }

      if (!alreadyBorrowed) {
        setStep("borrow", "active");
        const borrowTx = await writeContract(wagmiConfig, {
          chainId: destChainId,
          address: poolAddress,
          abi: AAVE_POOL_ABI,
          functionName: "borrow",
          args: [borrowAsset.address, borrowAmountBaseUnits, 2n, 0, address],
        });
        await waitForTransactionReceipt(wagmiConfig, { chainId: destChainId, hash: borrowTx });
        setStep("borrow", "done", { txHash: borrowTx, chainId: destChainId });
      }

      if (willDeliverElsewhere && !wasDone("deliver")) {
        setStep("deliver", "active", { detail: "getting a live quote..." });
        const deliverOrigin = findTokenRecord(liveTokens, borrowAsset.symbol, destNetwork);
        const deliverDest = findTokenRecord(liveTokens, "ETH", deliverNetwork) || findTokenRecord(liveTokens, "WETH", deliverNetwork);
        if (!deliverOrigin?.assetId || !deliverDest?.assetId) {
          throw new Error("token data is still loading — the borrowed funds are safe on " + CHAIN_LABEL[destNetwork]);
        }

        const res2 = await fetch(AURORA_QUOTE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            buildQuoteBody({
              dry: false,
              originToken: deliverOrigin,
              destToken: deliverDest,
              amountBaseUnits: borrowAmountBaseUnits.toString(),
              slippageBps: 50,
              recipient: address,
              refundTo: address,
              confidential: privateBridge,
            })
          ),
        });
        if (!res2.ok) throw new Error(await quoteErrorMessage(res2));
        const deliverQuote = await res2.json();
        const deliverDepositAddress = deliverQuote.quote?.depositAddress;
        if (!deliverDepositAddress) throw new Error("no deposit address returned for the delivery leg");

        setStep("deliver", "active", { detail: "confirm the transfer in your wallet..." });
        const deliverTxHash = await writeContract(wagmiConfig, {
          chainId: destChainId,
          address: borrowAsset.address,
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [deliverDepositAddress, borrowAmountBaseUnits],
        });
        setStep("deliver", "active", {
          detail: "sent — waiting for the bridge...",
          txHash: deliverTxHash,
          chainId: destChainId,
        });
        await waitForTransactionReceipt(wagmiConfig, { chainId: destChainId, hash: deliverTxHash });

        if (AURORA_DEPOSIT_SUBMIT_URL) {
          fetch(AURORA_DEPOSIT_SUBMIT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ txHash: deliverTxHash, depositAddress: deliverDepositAddress }),
          }).catch(() => {});
        }

        await pollUntilSettled(deliverDepositAddress, (detail) =>
          setStep("deliver", "active", { detail: STATUS_DETAIL_LABEL[detail] || detail, txHash: deliverTxHash, chainId: destChainId })
        );
        setStep("deliver", "done", { txHash: deliverTxHash, chainId: destChainId, detail: `arriving on ${CHAIN_LABEL[deliverNetwork]}` });
      }

      setRunStatus("success");
    } catch (err) {
      setRunStatus("error");
      setRunError(friendlyTxError(err, "borrow flow failed"));
      setRunLog((log) => log.map((s) => (s.status === "active" ? { ...s, status: "error" } : s)));
    }
  }

  const busy = runStatus === "running";
  const activeStepLabel = runLog.find((s) => s.status === "active")?.label;
  const buttonLabel = busy
    ? `${activeStepLabel || "working"}...`
    : runStatus === "success"
    ? "done — borrow again"
    : runStatus === "error"
    ? "try again"
    : !isConnected
    ? "connect wallet"
    : "borrow now";

  const fieldStyle = {
    border: "none",
    outline: "none",
    fontSize: 20,
    fontFamily: "inherit",
    background: "transparent",
    color: ink,
    width: "100%",
  };

  return (
    <div style={{ maxWidth: 380, margin: "0 auto", paddingBottom: 40 }}>
      <div className="hood-card-scale" style={{ border: `1px solid ${ink}`, background: paper, transformOrigin: "top center" }}>
        <div style={{ padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
            <div style={{ fontSize: 11, color: gray, fontWeight: 600 }}>collateral ({collateralToken.symbol})</div>
            <span
              onClick={() => setTokenPickerOpen((v) => !v)}
              style={{ fontSize: 11, color: gray, cursor: "pointer", textDecoration: "underline" }}
            >
              {tokenPickerOpen ? "[ close ]" : "[ deposit a different token ]"}
            </span>
          </div>
          <div style={{ borderBottom: `1px solid ${line}`, paddingBottom: 8, marginBottom: 6 }}>
            <input
              value={collateralAmount}
              onChange={(e) => setCollateralAmount(e.target.value)}
              placeholder="0"
              className="hood-field"
              style={fieldStyle}
            />
            {isConnected && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: gray, marginTop: 4 }}>
                <span>{collateralBalanceFormatted !== null ? `balance: ${collateralBalanceFormatted}` : ""}</span>
                {collateralBalanceFormatted !== null && (
                  <span>
                    <span onClick={() => fillCollateral(0.5)} style={{ cursor: "pointer", textDecoration: "underline", marginRight: 10 }}>
                      50%
                    </span>
                    <span onClick={() => fillCollateral(1)} style={{ cursor: "pointer", textDecoration: "underline" }}>
                      max
                    </span>
                  </span>
                )}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: tokenPickerOpen ? 10 : 18 }}>
            {AAVE_CHAINS.map(({ network, label }) => {
              const bal = ownedBalances[`USDC|${network}`];
              const isActive = collateralToken.symbol === "USDC" && collateralToken.network === network;
              return (
                <span
                  key={network}
                  onClick={() => {
                    setCollateralToken({ symbol: "USDC", network });
                    setCollateralTouched(true);
                    setTokenPickerOpen(false);
                  }}
                  style={{
                    fontSize: 11,
                    padding: "5px 9px",
                    border: `1px solid ${ink}`,
                    cursor: "pointer",
                    background: isActive ? ink : "transparent",
                    color: isActive ? paper : ink,
                  }}
                >
                  {label}
                  {bal !== undefined && bal > 0n ? ` (${truncateDecimalString(formatUnits(bal, 6), 2)})` : ""}
                </span>
              );
            })}
          </div>

          {tokenPickerOpen && (
            <div style={{ border: `1px solid ${line}`, marginBottom: 18 }}>
              <div style={{ padding: 8, borderBottom: `1px solid ${line}` }}>
                <input
                  value={tokenSearch}
                  onChange={(e) => setTokenSearch(e.target.value)}
                  placeholder="search a token you hold..."
                  className="hood-field"
                  style={{ width: "100%", border: "none", outline: "none", fontSize: 12, fontFamily: "inherit", background: "transparent", color: ink }}
                  autoFocus
                />
              </div>
              {ownedBalancesStatus !== "ready" && (
                <div style={{ padding: 10, fontSize: 11, color: gray }}>connect a wallet to see what you hold.</div>
              )}
              {ownedBalancesStatus === "ready" && ownedTokenOptions.length === 0 && (
                <div style={{ padding: 10, fontSize: 11, color: gray }}>nothing found{tokenSearch ? " for that search" : " — deposit into your wallet first"}.</div>
              )}
              {ownedTokenOptions.map((t) => (
                <div
                  key={`${t.symbol}|${t.network}`}
                  onClick={() => {
                    setCollateralToken({ symbol: t.symbol, network: t.network });
                    setCollateralTouched(true);
                    setTokenPickerOpen(false);
                    setTokenSearch("");
                    setCollateralAmount("");
                  }}
                  style={{ display: "flex", justifyContent: "space-between", padding: "8px 10px", fontSize: 12, cursor: "pointer", borderBottom: `1px solid ${line}` }}
                >
                  <span>
                    {t.symbol} <span style={{ color: gray }}>on {CHAIN_LABEL[t.network] || t.network}</span>
                  </span>
                  <span style={{ color: gray }}>{t.amountNum.toFixed(4)}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ fontSize: 11, color: gray, marginBottom: 4, fontWeight: 600 }}>borrow ({borrowSymbol})</div>
          <div style={{ borderBottom: `1px solid ${line}`, paddingBottom: 8, marginBottom: 6 }}>
            <input
              value={borrowAmount}
              onChange={(e) => setBorrowAmount(e.target.value)}
              placeholder="0"
              className="hood-field"
              style={fieldStyle}
            />
          </div>
          <div style={{ fontSize: 11, color: overMaxLtv ? "#B3261E" : gray, marginBottom: 18 }}>
            {maxBorrowAmount === null
              ? "enter a collateral amount to see how much you can borrow"
              : overMaxLtv
              ? `too much for this collateral — max ${maxBorrowAmount.toFixed(6)} ${borrowSymbol} at Aave's max LTV`
              : (
                <>
                  up to ~{maxBorrowAmount.toFixed(6)} {borrowSymbol} at Aave's max LTV ·{" "}
                  <span onClick={() => setBorrowAmount(safeBorrowAmount.toFixed(6))} style={{ cursor: "pointer", textDecoration: "underline" }}>
                    [ fill safe amount ]
                  </span>
                </>
              )}
          </div>

          <div style={{ fontSize: 11, color: gray, marginBottom: 6, fontWeight: 600 }}>aave borrow rates</div>
          {ratesStatus === "loading" && <div style={{ fontSize: 12, color: gray, marginBottom: 14 }}>checking live rates across chains...</div>}
          {ratesStatus === "error" && <div style={{ fontSize: 12, color: "#B3261E", marginBottom: 14 }}>{ratesError}</div>}
          {ratesStatus === "ready" && (
            <div style={{ border: `1px solid ${line}`, marginBottom: 14 }}>
              {rates.map((r) => {
                const isActive = r.network === activeNetwork;
                const deliverable = r.eligible && Boolean(findTokenRecord(liveTokens, r.borrowAsset.symbol, r.network)?.assetId);
                const subColor = isActive ? paper : gray;
                return (
                  <div
                    key={r.network}
                    onClick={() => {
                      if (!r.eligible) return;
                      setSelectedNetwork(r.network);
                      setNetworkTouched(true);
                    }}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "8px 10px",
                      fontSize: 12,
                      cursor: r.eligible ? "pointer" : "default",
                      background: isActive ? ink : "transparent",
                      color: isActive ? paper : r.eligible ? ink : gray,
                      borderBottom: `1px solid ${line}`,
                    }}
                  >
                    <span>
                      <div>
                        {r.label}
                        {r.network === bestNetwork ? " ★" : ""}
                      </div>
                      {r.eligible && (
                        <div style={{ fontSize: 10, color: subColor, marginTop: 2 }}>
                          {deliverable ? "receive on any chain" : "receive on this chain only"}
                        </div>
                      )}
                    </span>
                    <span>{r.eligible ? `${r.borrowApy.toFixed(2)}% apy` : r.reason}</span>
                  </div>
                );
              })}
            </div>
          )}

          {activeRate?.eligible && (
            <div style={{ fontSize: 11, color: gray, marginBottom: 14 }}>
              {needsSwap
                ? collateralToken.symbol === "USDC"
                  ? `bridges USDC from ${CHAIN_LABEL[collateralToken.network] || collateralToken.network} to ${activeRate.label} via NEAR intents, then supplies + borrows on Aave.`
                  : `converts ${collateralToken.symbol} on ${CHAIN_LABEL[collateralToken.network] || collateralToken.network} into USDC on ${activeRate.label} via NEAR intents, then supplies + borrows on Aave.`
                : `already on ${activeRate.label} — supplies + borrows directly.`}
              {deliversElsewhere && ` then sends the borrowed ${borrowSymbol} on to ${CHAIN_LABEL[receiveNetworkEffective]} — still one click.`}
              {insufficientLiquidity && (
                <div style={{ color: "#B3261E", marginTop: 4 }}>
                  only {activeRate.liquidity.toFixed(4)} {borrowSymbol} left to borrow on {activeRate.label}.
                </div>
              )}
            </div>
          )}

          {activeRate?.eligible && (
            <>
              <div style={{ fontSize: 11, color: gray, marginBottom: 6, fontWeight: 600 }}>
                receive borrowed funds on
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                {AAVE_CHAINS.map(({ network, label }) => {
                  const isBorrowChain = network === activeNetwork;
                  const disabled = !isBorrowChain && !canDeliverElsewhere;
                  const isActive = network === receiveNetworkEffective;
                  return (
                    <span
                      key={network}
                      onClick={() => {
                        if (disabled) return;
                        setReceiveNetwork(network);
                      }}
                      style={{
                        fontSize: 11,
                        padding: "5px 9px",
                        border: `1px solid ${disabled ? line : ink}`,
                        cursor: disabled ? "default" : "pointer",
                        background: isActive ? ink : "transparent",
                        color: isActive ? paper : disabled ? gray : ink,
                      }}
                    >
                      {label}
                      {isBorrowChain ? " (borrowed here)" : ""}
                    </span>
                  );
                })}
              </div>
              {!canDeliverElsewhere && (
                <div style={{ fontSize: 11, color: gray, marginBottom: 14 }}>
                  moving borrowed funds off {activeRate.label} isn't supported yet — you'll receive them there directly.
                </div>
              )}
            </>
          )}

          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 14, fontSize: 13 }}>
            <span onClick={() => setPrivateBridge(!privateBridge)} style={{ flexShrink: 0, cursor: "pointer" }}>
              [{privateBridge ? "x" : " "}]
            </span>
            <span onClick={() => setPrivateBridge(!privateBridge)} style={{ cursor: "pointer" }}>
              private bridge
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
                hides the link between your origin and destination wallets during the bridge. the Aave supply/borrow
                itself stays public on-chain — Aave has no private positions.
              </span>
            </span>
          </div>

          <button
            className="hood-cta"
            onClick={handleBorrow}
            disabled={busy}
            style={{
              width: "100%",
              padding: "11px 0",
              border: `1px solid ${ink}`,
              background: "transparent",
              color: ink,
              fontFamily: "inherit",
              fontSize: 13,
              letterSpacing: 1,
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {buttonLabel}
          </button>

          {runLog.length > 0 && (
            <div style={{ marginTop: 14 }}>
              {runLog.map((s) => (
                <div key={s.key} style={{ fontSize: 11, color: s.status === "error" ? "#B3261E" : gray, padding: "5px 0", borderTop: `1px solid ${line}` }}>
                  [{s.status === "done" ? "x" : s.status === "active" ? "." : s.status === "error" ? "!" : " "}] {s.label}
                  {s.detail ? ` — ${s.detail}` : ""}
                  {s.txHash && (
                    <>
                      {" "}
                      <a
                        href={`${EXPLORER_BY_CHAIN[s.chainId]}/tx/${s.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "inherit" }}
                      >
                        {s.txHash.slice(0, 10)}…
                      </a>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {runStatus === "error" && runError && <div style={{ marginTop: 8, fontSize: 11, color: "#B3261E" }}>{runError}</div>}
        </div>
      </div>
    </div>
  );
}

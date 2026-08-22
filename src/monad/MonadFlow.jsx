import { useEffect, useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { getBalance, readContract, writeContract, sendTransaction, waitForTransactionReceipt, estimateGas } from "wagmi/actions";
import { formatUnits, encodeFunctionData } from "viem";
import { useAppKit } from "@reown/appkit/react";
import { monad } from "@reown/appkit/networks";
import { wagmiConfig } from "../config/appkit.js";
import {
  CHAIN_ID_BY_NETWORK,
  NATIVE_SYMBOL_BY_CHAIN,
  EXPLORER_BY_CHAIN,
  ensureChain,
  toBaseUnits,
  truncateDecimalString,
  findTokenRecord,
  buildQuoteBody,
  quoteErrorMessage,
  friendlyTxError,
  STATUS_DETAIL_LABEL,
  AURORA_QUOTE_URL,
  AURORA_STATUS_URL,
  AURORA_DEPOSIT_SUBMIT_URL,
  ERC20_ABI,
} from "../lib/shared.js";
import { fetchMonadAaveMarket, AAVE_POOL_ABI, APPROVE_ABI, MAX_UINT256 } from "./aaveMonad.js";

// A short, curated shortlist — not a full search picker — since the ask
// here is "any of the popular ones", not "every one of the ~180 tokens
// Aurora Intents can move". Whatever's picked converts to USDC on Monad
// via the same Intents Connect swap Borrow.jsx uses, then gets supplied.
// Entries with no CHAIN_ID_BY_NETWORK mapping (tron) are non-EVM — the
// connected wallet can't sign on those chains at all, so those go through
// a manual "send to this address yourself" deposit instead of an
// auto-signed transfer.
const POPULAR_TOKENS = [
  { symbol: "USDC", network: "monad", chainLabel: "Monad" },
  { symbol: "MON", network: "monad", chainLabel: "Monad" },
  { symbol: "USDC", network: "base", chainLabel: "Base" },
  { symbol: "ETH", network: "eth", chainLabel: "Ethereum" },
  { symbol: "ETH", network: "base", chainLabel: "Base" },
  { symbol: "ETH", network: "arb", chainLabel: "Arbitrum" },
  { symbol: "USDC", network: "arb", chainLabel: "Arbitrum" },
  { symbol: "USDT0", network: "arb", chainLabel: "Arbitrum" },
  { symbol: "USDT", network: "eth", chainLabel: "Ethereum" },
  { symbol: "USDT", network: "tron", chainLabel: "Tron" },
  { symbol: "BNB", network: "bsc", chainLabel: "BNB Chain" },
  { symbol: "POL", network: "pol", chainLabel: "Polygon" },
];

const isTronAddress = (value) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value || "");

// Monad's gas accounting doesn't always match what viem/MetaMask's
// eth_estimateGas heuristics expect from an EVM chain, and a wallet that
// falls back to an inflated default on a borderline estimate can get its
// own suggested gas rejected by Monad's RPC as "exceeds transaction gas
// limit" — even though the call itself would succeed fine.
//
// Monad's own docs are explicit about the fix: gas fees there are charged
// on the *declared* gas_limit, not actual usage, so the right move is a
// tight estimate-plus-buffer (their guidance: ~7.5-10%), never a big flat
// number — too low reverts out-of-gas, too high both overcharges and can
// get rejected outright. estimateGasBuffered below does exactly that: a
// real eth_estimateGas call for this specific call, plus 20% headroom
// (generous relative to Monad's own 7.5% suggestion, since a demo
// failing outright is worse than a slightly bigger fee).
async function estimateGasBuffered({ chainId, to, abi, functionName, args, account }) {
  const data = encodeFunctionData({ abi, functionName, args });
  const est = await estimateGas(wagmiConfig, { chainId, to, data, account });
  return (est * 120n) / 100n;
}

const FEATURE_CARDS = [
  {
    title: "native yield",
    body: "your collateral stays supplied to Aave the whole time — it keeps earning supply APY even while the card is spending against it.",
  },
  {
    title: "no taxable event",
    body: "borrowing against your position isn't a sale — in most jurisdictions that means no capital-gains trigger, unlike cashing out. not tax advice, check your local rules.",
  },
  {
    title: "cashback in MON",
    body: "spend rewards land back in MON, sourced from Aave's own incentive program on Monad — not a separate points system.",
  },
  {
    title: "mastercard network",
    body: "issued through Immersve, a Mastercard principal member — works anywhere Mastercard is accepted, 70M+ merchants, Apple Pay ready.",
  },
];

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

const ink = "#0A0A0A";
const gray = "#6B6B6B";
const line = "#D8D6CE";
const paper = "#FDFCF9";

function HoodMark({ size = 22, c = ink, bg = paper }) {
  return (
    <svg width={size} height={size} viewBox="0 0 160 160" style={{ display: "block" }}>
      <path
        d="M 80 12 C 42 12 18 36 18 68 L 18 108 C 18 126 28 138 48 140 L 112 140 C 132 138 142 126 142 108 L 142 68 C 142 36 118 12 80 12 Z"
        fill={c}
      />
      <circle cx="55" cy="78" r="16" fill={bg} />
      <circle cx="105" cy="78" r="16" fill={bg} />
    </svg>
  );
}

// Purely a visual affordance for now — no real card number behind it yet
// (that's the sandbox card-issuance API, wired up separately later). Toggles
// between the masked placeholder and a demo number so the design reads
// right before the real data exists.
function EyeIcon({ open, size = 16, c = paper }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ display: "block" }}>
      <path
        d="M2 12C2 12 5.5 5.5 12 5.5C18.5 5.5 22 12 22 12C22 12 18.5 18.5 12 18.5C5.5 18.5 2 12 2 12Z"
        stroke={c}
        strokeWidth="1.6"
      />
      <circle cx="12" cy="12" r="3.2" stroke={c} strokeWidth="1.6" />
      {!open && <line x1="3.5" y1="20.5" x2="20.5" y2="3.5" stroke={c} strokeWidth="1.6" />}
    </svg>
  );
}

export default function MonadFlow() {
  const { open } = useAppKit();
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();

  const [liveTokens, setLiveTokens] = useState(null);
  const [balances, setBalances] = useState({});
  const [balancesStatus, setBalancesStatus] = useState("idle");

  const [pickedToken, setPickedToken] = useState(null);
  const [amount, setAmount] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cardRevealed, setCardRevealed] = useState(false);
  const [manualRefundAddress, setManualRefundAddress] = useState("");
  const [manualDeposit, setManualDeposit] = useState(null); // { address, amount, symbol }

  const [market, setMarket] = useState(null);
  const [marketStatus, setMarketStatus] = useState("loading");

  const [position, setPosition] = useState(null); // { suppliedFormatted, borrowedFormatted }
  // What Aave itself says this wallet already holds on the pool — read
  // fresh from the contract, not from local state, so a supply that
  // succeeded in an earlier attempt (even one where borrow then failed,
  // or a page reload) still shows up and stays withdrawable. This is the
  // real source of truth; `position` above is just this session's own log.
  const [existingPosition, setExistingPosition] = useState(null); // { totalCollateralUsd, totalDebtUsd }
  const [depositStatus, setDepositStatus] = useState("idle"); // idle | running | error
  const [depositPhase, setDepositPhase] = useState("");
  const [depositError, setDepositError] = useState("");

  const [withdrawStatus, setWithdrawStatus] = useState("idle"); // idle | running | error
  const [withdrawPhase, setWithdrawPhase] = useState("");
  const [withdrawError, setWithdrawError] = useState("");
  const [lastTx, setLastTx] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch("https://1click.chaindefuser.com/v0/tokens")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setLiveTokens(
          data
            .filter((t) => t.symbol && t.blockchain)
            .map((t) => ({
              symbol: t.symbol,
              network: t.blockchain,
              price: t.price,
              contractAddress: t.contractAddress,
              assetId: t.assetId,
              decimals: t.decimals,
            }))
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchMonadAaveMarket()
      .then((m) => {
        if (!cancelled) {
          setMarket(m);
          setMarketStatus("ready");
        }
      })
      .catch(() => !cancelled && setMarketStatus("error"));
    return () => {
      cancelled = true;
    };
  }, []);

  // getUserAccountData's Base-currency fields are in the pool's price
  // oracle unit — 8 decimals on every Aave v3 deployment so far, same as
  // the Chainlink feeds it reads from.
  useEffect(() => {
    if (!isConnected || !address || marketStatus !== "ready") {
      setExistingPosition(null);
      return;
    }
    let cancelled = false;
    readContract(wagmiConfig, {
      chainId: monad.id,
      address: market.poolAddress,
      abi: AAVE_POOL_ABI,
      functionName: "getUserAccountData",
      args: [address],
    })
      .then(([totalCollateralBase, totalDebtBase, availableBorrowsBase]) => {
        if (cancelled) return;
        setExistingPosition({
          totalCollateralUsd: Number(totalCollateralBase) / 1e8,
          totalDebtUsd: Number(totalDebtBase) / 1e8,
          availableBorrowsUsd: Number(availableBorrowsBase) / 1e8,
        });
      })
      .catch(() => !cancelled && setExistingPosition(null));
    return () => {
      cancelled = true;
    };
  }, [isConnected, address, marketStatus, market, position, withdrawStatus]);

  useEffect(() => {
    if (!isConnected || !address) {
      setBalances({});
      setBalancesStatus("idle");
      return;
    }
    let cancelled = false;
    setBalancesStatus("loading");
    Promise.all(
      POPULAR_TOKENS.map(async (t) => {
        const chainId = CHAIN_ID_BY_NETWORK[t.network];
        if (!chainId) return null;
        try {
          if (NATIVE_SYMBOL_BY_CHAIN[chainId] === t.symbol) {
            const bal = await getBalance(wagmiConfig, { address, chainId });
            return [`${t.symbol}|${t.network}`, bal.value];
          }
          const record = liveTokens && findTokenRecord(liveTokens, t.symbol, t.network);
          if (!record?.contractAddress) return null;
          const bal = await readContract(wagmiConfig, {
            chainId,
            address: record.contractAddress,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [address],
          });
          return [`${t.symbol}|${t.network}`, bal];
        } catch {
          return null;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setBalances(Object.fromEntries(entries.filter(Boolean)));
      setBalancesStatus("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [isConnected, address, liveTokens]);

  const pickedRecord = pickedToken ? findTokenRecord(liveTokens, pickedToken.symbol, pickedToken.network) : null;
  const pickedBalance = pickedToken ? balances[`${pickedToken.symbol}|${pickedToken.network}`] : undefined;
  const pickedDecimals = pickedRecord?.decimals ?? 18;
  const needsSwap = Boolean(pickedToken && !(pickedToken.symbol === "USDC" && pickedToken.network === "monad"));
  const pickedIsManual = Boolean(pickedToken && !CHAIN_ID_BY_NETWORK[pickedToken.network]);

  // What's actually in the wallet, in a plain token/chain/amount list —
  // held balances first (biggest first), then the rest of the popular set
  // still pickable with a "0" amount rather than hidden entirely.
  const pickerRows = POPULAR_TOKENS.map((t) => {
    const record = findTokenRecord(liveTokens, t.symbol, t.network);
    const bal = balances[`${t.symbol}|${t.network}`];
    const amountNum = bal !== undefined ? Number(formatUnits(bal, record?.decimals ?? 18)) : 0;
    return { ...t, amountNum, held: bal !== undefined && bal > 0n };
  }).sort((a, b) => (b.held === a.held ? b.amountNum - a.amountNum : b.held - a.held));

  function fillMax() {
    if (pickedBalance === undefined) return;
    setAmount(truncateDecimalString(formatUnits(pickedBalance, pickedDecimals), pickedDecimals));
  }

  // Everything below is the "user doesn't see this" part — one button,
  // one continuous action: convert (if needed) -> supply -> borrow. The
  // phase text is a friendly gloss, not a technical step tracker.
  async function handleDeposit() {
    if (!pickedToken || !amount || Number(amount) <= 0 || !market) return;
    if (pickedIsManual && !isTronAddress(manualRefundAddress)) {
      setDepositStatus("error");
      setDepositError(`enter a valid ${pickedToken.chainLabel} address above for refunds`);
      return;
    }
    setDepositError("");
    setDepositStatus("running");
    try {
      // Refetch rather than trust the market snapshot from page load —
      // which stablecoin is cheapest to borrow, whether it's still enabled,
      // and how much liquidity it has can all drift in the time between
      // loading the page and actually clicking deposit. Shadows the outer
      // `market` for the rest of this function.
      const market = await fetchMonadAaveMarket();
      setMarket(market);

      let supplyAmountBaseUnits;
      const originNetwork = pickedToken.network;
      const originChainId = CHAIN_ID_BY_NETWORK[originNetwork];

      if (needsSwap && pickedIsManual) {
        // Non-EVM origin (Tron) — the connected wallet can't sign there at
        // all, so this is Aurora's deposit-address flow instead: get a
        // quote, show the address, and wait for the user to send it
        // themselves from whatever wallet they actually hold it in.
        setDepositPhase("getting a deposit address...");
        const originToken = pickedRecord;
        const destToken = findTokenRecord(liveTokens, "USDC", "monad");
        if (!originToken?.assetId || !destToken?.assetId) throw new Error("token data is still loading — try again in a moment");

        const amountBaseUnits = toBaseUnits(amount, originToken.decimals);
        const res = await fetch(AURORA_QUOTE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            buildQuoteBody({ dry: false, originToken, destToken, amountBaseUnits, slippageBps: 50, recipient: address, refundTo: manualRefundAddress })
          ),
        });
        if (!res.ok) throw new Error(await quoteErrorMessage(res));
        const quoteData = await res.json();
        const depositAddress = quoteData.quote?.depositAddress;
        if (!depositAddress) throw new Error("no deposit address returned");

        setManualDeposit({ address: depositAddress, amount, symbol: originToken.symbol });
        setDepositPhase("waiting for your deposit...");
        await pollUntilSettled(depositAddress, (detail) => setDepositPhase(STATUS_DETAIL_LABEL[detail] || "settling..."));
        setManualDeposit(null);

        await ensureChain(monad.id);
        supplyAmountBaseUnits = await readContract(wagmiConfig, {
          chainId: monad.id,
          address: market.collateralAsset.address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        });
      } else if (needsSwap) {
        setDepositPhase("moving your deposit...");
        const originToken = pickedRecord;
        const destToken = findTokenRecord(liveTokens, "USDC", "monad");
        if (!originToken?.assetId || !destToken?.assetId) throw new Error("token data is still loading — try again in a moment");

        const amountBaseUnits = toBaseUnits(amount, originToken.decimals);
        const res = await fetch(AURORA_QUOTE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            buildQuoteBody({ dry: false, originToken, destToken, amountBaseUnits, slippageBps: 50, recipient: address, refundTo: address })
          ),
        });
        if (!res.ok) throw new Error(await quoteErrorMessage(res));
        const quoteData = await res.json();
        const depositAddress = quoteData.quote?.depositAddress;
        if (!depositAddress) throw new Error("no deposit address returned");

        setDepositPhase("confirm in your wallet...");
        await ensureChain(originChainId);
        const isNative = NATIVE_SYMBOL_BY_CHAIN[originChainId] === originToken.symbol;
        const txHash = isNative
          ? await sendTransaction(wagmiConfig, { chainId: originChainId, to: depositAddress, value: BigInt(amountBaseUnits) })
          : await writeContract(wagmiConfig, {
              chainId: originChainId,
              address: originToken.contractAddress,
              abi: ERC20_ABI,
              functionName: "transfer",
              args: [depositAddress, BigInt(amountBaseUnits)],
            });
        setDepositPhase("on its way...");
        await waitForTransactionReceipt(wagmiConfig, { chainId: originChainId, hash: txHash });

        if (AURORA_DEPOSIT_SUBMIT_URL) {
          fetch(AURORA_DEPOSIT_SUBMIT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ txHash, depositAddress }) }).catch(() => {});
        }

        await pollUntilSettled(depositAddress, (detail) => setDepositPhase(STATUS_DETAIL_LABEL[detail] || "settling..."));

        await ensureChain(monad.id);
        supplyAmountBaseUnits = await readContract(wagmiConfig, {
          chainId: monad.id,
          address: market.collateralAsset.address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [address],
        });
      } else {
        await ensureChain(monad.id);
        supplyAmountBaseUnits = BigInt(toBaseUnits(amount, market.collateralAsset.decimals));
      }

      setDepositPhase("approving...");
      const approveArgs = { chainId: monad.id, to: market.collateralAsset.address, abi: APPROVE_ABI, functionName: "approve", args: [market.poolAddress, supplyAmountBaseUnits], account: address };
      const approveTx = await writeContract(wagmiConfig, {
        chainId: monad.id,
        address: market.collateralAsset.address,
        abi: APPROVE_ABI,
        functionName: "approve",
        args: [market.poolAddress, supplyAmountBaseUnits],
        gas: await estimateGasBuffered(approveArgs),
      });
      await waitForTransactionReceipt(wagmiConfig, { chainId: monad.id, hash: approveTx });

      setDepositPhase("activating your card...");
      const supplyArgs = { chainId: monad.id, to: market.poolAddress, abi: AAVE_POOL_ABI, functionName: "supply", args: [market.collateralAsset.address, supplyAmountBaseUnits, address, 0], account: address };
      const supplyTx = await writeContract(wagmiConfig, {
        chainId: monad.id,
        address: market.poolAddress,
        abi: AAVE_POOL_ABI,
        functionName: "supply",
        args: [market.collateralAsset.address, supplyAmountBaseUnits, address, 0],
        gas: await estimateGasBuffered(supplyArgs),
      });
      await waitForTransactionReceipt(wagmiConfig, { chainId: monad.id, hash: supplyTx });
      const suppliedFormatted = truncateDecimalString(formatUnits(supplyAmountBaseUnits, market.collateralAsset.decimals), 6);

      // Read the account fresh rather than computing from just this
      // deposit's own numbers — availableBorrowsBase already accounts for
      // *all* collateral this wallet has on the pool (including anything
      // supplied in an earlier attempt), so topping up an existing
      // position borrows against the true total, not just what just got
      // supplied. 95% of that (not Aave's raw max) keeps a sliver of
      // headroom below the liquidation threshold.
      setDepositPhase("checking borrow limit...");
      const [, , availableBorrowsBase] = await readContract(wagmiConfig, {
        chainId: monad.id,
        address: market.poolAddress,
        abi: AAVE_POOL_ABI,
        functionName: "getUserAccountData",
        args: [address],
      });
      const safeBorrow = (Number(availableBorrowsBase) / 1e8 / market.borrowAsset.usdPrice) * 0.95;
      const borrowAmountBaseUnits = BigInt(toBaseUnits(safeBorrow.toFixed(6), market.borrowAsset.decimals));

      // Nothing meaningful to borrow yet (e.g. this deposit alone doesn't
      // clear the reserve's minimum, or the account has no borrow room for
      // some other reason) — land safely on "supplied, one step left"
      // instead of sending a doomed near-zero borrow call.
      if (borrowAmountBaseUnits > 0n) {
        setDepositPhase("borrowing...");
        const borrowArgs = { chainId: monad.id, to: market.poolAddress, abi: AAVE_POOL_ABI, functionName: "borrow", args: [market.borrowAsset.address, borrowAmountBaseUnits, 2n, 0, address], account: address };
        const borrowTx = await writeContract(wagmiConfig, {
          chainId: monad.id,
          address: market.poolAddress,
          abi: AAVE_POOL_ABI,
          functionName: "borrow",
          args: [market.borrowAsset.address, borrowAmountBaseUnits, 2n, 0, address],
          gas: await estimateGasBuffered(borrowArgs),
        });
        await waitForTransactionReceipt(wagmiConfig, { chainId: monad.id, hash: borrowTx });
        setLastTx({ hash: borrowTx, chainId: monad.id });
      }

      setPosition({
        suppliedFormatted,
        borrowedFormatted: truncateDecimalString(formatUnits(borrowAmountBaseUnits, market.borrowAsset.decimals), 6),
      });
      setDepositStatus("idle");
      setDepositPhase("");
    } catch (err) {
      setManualDeposit(null);
      setDepositStatus("error");
      // Tag which step actually failed (the phase label at the moment of
      // the throw) — "unknown reason" from a bare contract revert is a lot
      // more actionable as "unknown reason (during: borrowing...)".
      const stepTag = depositPhase ? ` (during: ${depositPhase})` : "";
      setDepositError(friendlyTxError(err, "deposit failed") + stepTag);
    }
  }

  // Aave's own account data is the real source of truth for whether this
  // wallet has anything to withdraw — not just this session's `position`,
  // which would miss a supply that succeeded in an earlier attempt (e.g.
  // one where borrow then failed) or survive a page reload.
  const hasSupplied = Boolean(position) || (existingPosition?.totalCollateralUsd ?? 0) > 0.000001;
  const hasDebt = Boolean(position?.borrowedFormatted && Number(position.borrowedFormatted) > 0) || (existingPosition?.totalDebtUsd ?? 0) > 0.000001;
  // The one number the user actually sees — "deposit" means spendable
  // balance, i.e. what got borrowed, not the collateral locked behind it.
  // If collateral is in but the borrow leg hasn't landed yet, show what's
  // available to activate instead of a confusing $0.
  const depositDisplay = position
    ? Number(position.borrowedFormatted)
    : hasDebt
    ? existingPosition.totalDebtUsd
    : (existingPosition?.availableBorrowsUsd ?? 0) * 0.95;

  // Full unwind, back to the wallet — repay the whole debt, then withdraw
  // the whole collateral. Aave's own "repay everything / withdraw
  // everything" sentinel (max uint256) so this is never off by the few
  // seconds of interest that accrued since the numbers above were read.
  async function handleWithdraw() {
    if (!market || !hasSupplied) return;
    setWithdrawError("");
    setWithdrawStatus("running");
    try {
      await ensureChain(monad.id);

      // Skip repay entirely when there's no real debt — e.g. a supply that
      // went through on its own (borrow failed or was never attempted).
      // Also avoids repaying the wrong reserve: which stablecoin is
      // "cheapest to borrow" can drift day to day, so market.borrowAsset
      // might not even be what an old debt is actually denominated in.
      if (hasDebt) {
        setWithdrawPhase("clearing your balance...");
        const repayApproveArgs = { chainId: monad.id, to: market.borrowAsset.address, abi: APPROVE_ABI, functionName: "approve", args: [market.poolAddress, MAX_UINT256], account: address };
        const repayApproveTx = await writeContract(wagmiConfig, {
          chainId: monad.id,
          address: market.borrowAsset.address,
          abi: APPROVE_ABI,
          functionName: "approve",
          args: [market.poolAddress, MAX_UINT256],
          gas: await estimateGasBuffered(repayApproveArgs),
        });
        await waitForTransactionReceipt(wagmiConfig, { chainId: monad.id, hash: repayApproveTx });

        const repayArgs = { chainId: monad.id, to: market.poolAddress, abi: AAVE_POOL_ABI, functionName: "repay", args: [market.borrowAsset.address, MAX_UINT256, 2n, address], account: address };
        const repayTx = await writeContract(wagmiConfig, {
          chainId: monad.id,
          address: market.poolAddress,
          abi: AAVE_POOL_ABI,
          functionName: "repay",
          args: [market.borrowAsset.address, MAX_UINT256, 2n, address],
          gas: await estimateGasBuffered(repayArgs),
        });
        await waitForTransactionReceipt(wagmiConfig, { chainId: monad.id, hash: repayTx });
      }

      setWithdrawPhase("sending it back to your wallet...");
      const withdrawArgs = { chainId: monad.id, to: market.poolAddress, abi: AAVE_POOL_ABI, functionName: "withdraw", args: [market.collateralAsset.address, MAX_UINT256, address], account: address };
      const withdrawTx = await writeContract(wagmiConfig, {
        chainId: monad.id,
        address: market.poolAddress,
        abi: AAVE_POOL_ABI,
        functionName: "withdraw",
        args: [market.collateralAsset.address, MAX_UINT256, address],
        gas: await estimateGasBuffered(withdrawArgs),
      });
      await waitForTransactionReceipt(wagmiConfig, { chainId: monad.id, hash: withdrawTx });

      setLastTx({ hash: withdrawTx, chainId: monad.id });
      setPosition(null);
      setAmount("");
      setPickedToken(null);
      setWithdrawStatus("idle");
      setWithdrawPhase("");
    } catch (err) {
      setWithdrawStatus("error");
      setWithdrawError(friendlyTxError(err, "withdraw failed"));
    }
  }

  const depositing = depositStatus === "running";
  const withdrawing = withdrawStatus === "running";

  return (
    <div style={{ background: paper, minHeight: "100vh", fontFamily: "'IBM Plex Mono', monospace", color: ink, padding: "24px 20px 60px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .mf-field::placeholder { color: #B9B6AB; }
        .mf-cta:hover { background: ${ink} !important; color: ${paper} !important; }
        .mf-tip-wrap { position: relative; display: inline-flex; }
        .mf-tip {
          position: absolute; top: 24px; right: 0;
          background: ${ink}; color: ${paper};
          font-size: 11px; padding: 10px 12px; width: 220px; line-height: 1.5;
          opacity: 0; pointer-events: none; transition: opacity 0.15s ease; z-index: 5;
        }
        .mf-tip-wrap:hover .mf-tip { opacity: 1; }
      `}</style>

      <div style={{ maxWidth: 400, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 20, fontWeight: 600 }}>[hood]</div>
          {isConnected ? (
            <span onClick={() => disconnect()} style={{ fontSize: 11, cursor: "pointer", textDecoration: "underline", color: gray }}>
              {address.slice(0, 6)}…{address.slice(-4)} — disconnect
            </span>
          ) : (
            <button
              className="mf-cta"
              onClick={() => open()}
              style={{ border: `1px solid ${ink}`, background: "transparent", color: ink, fontFamily: "inherit", fontSize: 12, padding: "8px 14px", cursor: "pointer" }}
            >
              [ connect wallet ]
            </button>
          )}
        </div>

        {/* the card — always the hero */}
        <div style={{ background: ink, color: paper, padding: "22px 20px", marginBottom: 4, minHeight: 150, position: "relative" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <HoodMark size={22} c={paper} bg={ink} />
              <div style={{ fontSize: 12, letterSpacing: 1 }}>my hood card</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                onClick={() => setCardRevealed((v) => !v)}
                style={{ cursor: "pointer", opacity: 0.85, display: "flex" }}
                title={cardRevealed ? "hide card number" : "reveal card number"}
              >
                <EyeIcon open={cardRevealed} />
              </span>
              <span className="mf-tip-wrap">
                <span
                  style={{
                    border: `1px solid ${paper}`,
                    borderRadius: "50%",
                    width: 16,
                    height: 16,
                    fontSize: 10,
                    fontStyle: "italic",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: 0.85,
                  }}
                >
                  ?
                </span>
                <span className="mf-tip" style={{ color: paper }}>
                  your deposit supplies into Aave on Monad and borrows a cheaper stablecoin against it — that spread
                  funds the card. the collateral keeps earning the whole time. one shot, no loop.
                </span>
              </span>
            </div>
          </div>

          <div style={{ marginTop: 22, fontSize: 20, letterSpacing: 2 }}>
            {cardRevealed ? "4242  4242  4242  4242" : "••••  ••••  ••••  ••••"}
          </div>
          {cardRevealed && (
            <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>demo number — sandbox card issuance connects here next</div>
          )}

          {hasSupplied ? (
            <>
              <div style={{ marginTop: 16, fontSize: 26, letterSpacing: 1 }}>
                ${depositDisplay.toFixed(2)}
              </div>
              <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>available to spend</div>
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <span style={{ fontSize: 10, border: `1px solid ${paper}`, padding: "4px 8px", opacity: 0.9 }}>[ native yield ]</span>
                <span style={{ fontSize: 10, border: `1px solid ${paper}`, padding: "4px 8px", opacity: 0.9 }}>[ tax-free spend ]</span>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 16 }}>
                {!isConnected ? "connect a wallet to activate" : "deposit to activate your card"}
              </div>
            </>
          )}
        </div>
        <div style={{ fontSize: 10, color: gray, marginBottom: 20 }}>
          sandbox demo — Monad hackathon. no real card issuance in this build yet.
        </div>

        {/* controls */}
        {!isConnected && (
          <div style={{ border: `1px solid ${ink}`, background: paper, padding: 16, textAlign: "center", fontSize: 12, color: gray }}>
            connect your wallet above to deposit
          </div>
        )}

        {isConnected && (
          <div style={{ border: `1px solid ${ink}`, background: paper, padding: 16 }}>
          {true && (
            <>
              <div style={{ fontSize: 11, color: gray, fontWeight: 600, marginBottom: 6 }}>deposit — choose a token</div>
              <div
                onClick={() => setPickerOpen((v) => !v)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  border: `1px solid ${ink}`,
                  padding: "10px 12px",
                  marginBottom: pickerOpen ? 0 : 12,
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                <span style={{ color: pickedToken ? ink : "#B9B6AB" }}>
                  {pickedToken ? (
                    <>
                      {pickedToken.symbol} <span style={{ color: gray }}>on {pickedToken.chainLabel}</span>
                    </>
                  ) : (
                    "choose a token"
                  )}
                </span>
                <span style={{ color: gray, fontSize: 11 }}>{pickerOpen ? "▲" : "▼"}</span>
              </div>

              {pickerOpen && (
                <div style={{ border: `1px solid ${ink}`, borderTop: "none", marginBottom: 12, maxHeight: 260, overflowY: "auto" }}>
                  {balancesStatus === "loading" && (
                    <div style={{ padding: 10, fontSize: 11, color: gray }}>checking your balances...</div>
                  )}
                  {pickerRows.map((t) => {
                    const isActive = pickedToken?.symbol === t.symbol && pickedToken?.network === t.network;
                    return (
                      <div
                        key={`${t.symbol}|${t.network}`}
                        onClick={() => {
                          setPickedToken(t);
                          setAmount("");
                          setPickerOpen(false);
                        }}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "9px 10px",
                          fontSize: 12,
                          cursor: "pointer",
                          borderTop: `1px solid ${line}`,
                          background: isActive ? ink : "transparent",
                          color: isActive ? paper : t.held ? ink : gray,
                        }}
                      >
                        <span>
                          {t.symbol} <span style={{ opacity: 0.7 }}>on {t.chainLabel}</span>
                        </span>
                        <span>{t.held ? t.amountNum.toFixed(4) : "—"}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {pickedToken && (
                <div style={{ borderBottom: `1px solid ${line}`, paddingBottom: 8, marginBottom: 14 }}>
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0"
                    className="mf-field"
                    style={{ border: "none", outline: "none", fontSize: 20, fontFamily: "inherit", background: "transparent", color: ink, width: "100%" }}
                  />
                  {pickedBalance !== undefined && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: gray, marginTop: 4 }}>
                      <span>balance: {truncateDecimalString(formatUnits(pickedBalance, pickedDecimals), 6)}</span>
                      <span onClick={fillMax} style={{ cursor: "pointer", textDecoration: "underline" }}>
                        max
                      </span>
                    </div>
                  )}
                </div>
              )}

              {pickedIsManual && !manualDeposit && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: gray, marginBottom: 4 }}>your {pickedToken.chainLabel} address (for refunds)</div>
                  <input
                    value={manualRefundAddress}
                    onChange={(e) => setManualRefundAddress(e.target.value)}
                    placeholder={`address on ${pickedToken.chainLabel}`}
                    className="mf-field"
                    style={{ width: "100%", border: "none", borderBottom: `1px solid ${line}`, outline: "none", padding: "6px 0", fontSize: 13, fontFamily: "inherit", background: "transparent", color: ink }}
                  />
                </div>
              )}

              {manualDeposit && (
                <div style={{ border: `1px solid ${ink}`, padding: 12, marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: gray, marginBottom: 6 }}>
                    send exactly <strong style={{ color: ink }}>{manualDeposit.amount} {manualDeposit.symbol}</strong> to:
                  </div>
                  <div
                    onClick={() => navigator.clipboard.writeText(manualDeposit.address)}
                    style={{ fontSize: 12, wordBreak: "break-all", cursor: "pointer", textDecoration: "underline" }}
                    title="click to copy"
                  >
                    {manualDeposit.address}
                  </div>
                  <div style={{ fontSize: 11, color: gray, marginTop: 8 }}>{depositPhase || "waiting for your deposit..."}</div>
                </div>
              )}

              {(() => {
                const missingInput =
                  !pickedToken || !amount || Number(amount) <= 0 || (pickedIsManual && !isTronAddress(manualRefundAddress));
                const notReady = missingInput || marketStatus !== "ready";
                const isDisabled = depositing || notReady;
                return (
                  <>
                    <button
                      className="mf-cta"
                      onClick={handleDeposit}
                      disabled={isDisabled}
                      style={{
                        width: "100%",
                        padding: "11px 0",
                        border: `1px solid ${notReady && !depositing ? line : ink}`,
                        background: "transparent",
                        color: notReady && !depositing ? gray : ink,
                        fontFamily: "inherit",
                        fontSize: 13,
                        letterSpacing: 1,
                        cursor: isDisabled ? "not-allowed" : "pointer",
                        opacity: depositing ? 0.7 : 1,
                      }}
                    >
                      {depositing ? depositPhase || "working..." : "deposit"}
                    </button>
                    {missingInput && (
                      <div style={{ fontSize: 11, color: gray, marginTop: 8 }}>
                        {!pickedToken
                          ? "choose a token above first."
                          : !amount || Number(amount) <= 0
                          ? "enter an amount to deposit."
                          : `enter your ${pickedToken.chainLabel} address above for refunds.`}
                      </div>
                    )}
                  </>
                );
              })()}
              {depositStatus === "error" && depositError && <div style={{ fontSize: 11, color: "#B3261E", marginTop: 8 }}>{depositError}</div>}
              {marketStatus === "error" && <div style={{ fontSize: 11, color: "#B3261E", marginTop: 8 }}>could not load Aave's Monad market — try refreshing.</div>}
            </>
          )}

          {hasSupplied && (
            <>
              <div style={{ borderTop: `1px solid ${line}`, marginTop: 14, paddingTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 12 }}>
                  deposit <strong>~${depositDisplay.toFixed(2)}</strong>
                </div>
                <button
                  className="mf-cta"
                  onClick={handleWithdraw}
                  disabled={withdrawing}
                  title="withdraw to wallet"
                  style={{
                    width: 34,
                    height: 34,
                    flexShrink: 0,
                    border: `1px solid ${ink}`,
                    background: "transparent",
                    color: ink,
                    fontFamily: "inherit",
                    fontSize: 16,
                    cursor: "pointer",
                    opacity: withdrawing ? 0.6 : 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {withdrawing ? "…" : "↓"}
                </button>
              </div>
              {withdrawStatus === "error" && withdrawError && <div style={{ fontSize: 11, color: "#B3261E", marginTop: 8 }}>{withdrawError}</div>}
            </>
          )}

          {lastTx && (
            <div style={{ fontSize: 11, color: gray, marginTop: 10 }}>
              last tx:{" "}
              <a href={`${EXPLORER_BY_CHAIN[lastTx.chainId]}/tx/${lastTx.hash}`} target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>
                {lastTx.hash.slice(0, 10)}…
              </a>
            </div>
          )}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 24 }}>
          {FEATURE_CARDS.map((f) => (
            <div key={f.title} style={{ border: `1px solid ${line}`, padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>[ {f.title} ]</div>
              <div style={{ fontSize: 11, color: gray, lineHeight: 1.6 }}>{f.body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

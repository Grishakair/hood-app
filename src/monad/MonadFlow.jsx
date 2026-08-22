import { useEffect, useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { getBalance, readContract, writeContract, sendTransaction, waitForTransactionReceipt } from "wagmi/actions";
import { formatUnits } from "viem";
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
const POPULAR_TOKENS = [
  { symbol: "USDC", network: "monad", chainLabel: "Monad" },
  { symbol: "MON", network: "monad", chainLabel: "Monad" },
  { symbol: "USDC", network: "base", chainLabel: "Base" },
  { symbol: "ETH", network: "eth", chainLabel: "Ethereum" },
  { symbol: "ETH", network: "base", chainLabel: "Base" },
  { symbol: "USDT", network: "eth", chainLabel: "Ethereum" },
  { symbol: "BNB", network: "bsc", chainLabel: "BNB Chain" },
  { symbol: "POL", network: "pol", chainLabel: "Polygon" },
];

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

  const [market, setMarket] = useState(null);
  const [marketStatus, setMarketStatus] = useState("loading");

  const [position, setPosition] = useState(null); // { suppliedFormatted, borrowedFormatted }
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

  function fillMax() {
    if (pickedBalance === undefined) return;
    setAmount(truncateDecimalString(formatUnits(pickedBalance, pickedDecimals), pickedDecimals));
  }

  // Everything below is the "user doesn't see this" part — one button,
  // one continuous action: convert (if needed) -> supply -> borrow. The
  // phase text is a friendly gloss, not a technical step tracker.
  async function handleDeposit() {
    if (!pickedToken || !amount || Number(amount) <= 0 || !market) return;
    setDepositError("");
    setDepositStatus("running");
    try {
      let supplyAmountBaseUnits;
      const originNetwork = pickedToken.network;
      const originChainId = CHAIN_ID_BY_NETWORK[originNetwork];

      if (needsSwap) {
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

      setDepositPhase("activating your card...");
      const approveTx = await writeContract(wagmiConfig, {
        chainId: monad.id,
        address: market.collateralAsset.address,
        abi: APPROVE_ABI,
        functionName: "approve",
        args: [market.poolAddress, supplyAmountBaseUnits],
      });
      await waitForTransactionReceipt(wagmiConfig, { chainId: monad.id, hash: approveTx });

      const supplyTx = await writeContract(wagmiConfig, {
        chainId: monad.id,
        address: market.poolAddress,
        abi: AAVE_POOL_ABI,
        functionName: "supply",
        args: [market.collateralAsset.address, supplyAmountBaseUnits, address, 0],
      });
      await waitForTransactionReceipt(wagmiConfig, { chainId: monad.id, hash: supplyTx });
      const suppliedFormatted = truncateDecimalString(formatUnits(supplyAmountBaseUnits, market.collateralAsset.decimals), 6);

      const usdValue = Number(suppliedFormatted) * market.collateralAsset.usdPrice;
      const safeBorrow = (usdValue * market.collateralAsset.maxLtv * 0.85) / market.borrowAsset.usdPrice;
      const borrowAmountBaseUnits = BigInt(toBaseUnits(safeBorrow.toFixed(6), market.borrowAsset.decimals));

      const borrowTx = await writeContract(wagmiConfig, {
        chainId: monad.id,
        address: market.poolAddress,
        abi: AAVE_POOL_ABI,
        functionName: "borrow",
        args: [market.borrowAsset.address, borrowAmountBaseUnits, 2n, 0, address],
      });
      await waitForTransactionReceipt(wagmiConfig, { chainId: monad.id, hash: borrowTx });

      setPosition({
        suppliedFormatted,
        borrowedFormatted: truncateDecimalString(formatUnits(borrowAmountBaseUnits, market.borrowAsset.decimals), 6),
      });
      setLastTx({ hash: borrowTx, chainId: monad.id });
      setDepositStatus("idle");
      setDepositPhase("");
    } catch (err) {
      setDepositStatus("error");
      setDepositError(friendlyTxError(err, "deposit failed"));
    }
  }

  // Full unwind, back to the wallet — repay the whole debt, then withdraw
  // the whole collateral. Aave's own "repay everything / withdraw
  // everything" sentinel (max uint256) so this is never off by the few
  // seconds of interest that accrued since the numbers above were read.
  async function handleWithdraw() {
    if (!market || !position) return;
    setWithdrawError("");
    setWithdrawStatus("running");
    try {
      await ensureChain(monad.id);

      setWithdrawPhase("clearing your balance...");
      const repayApproveTx = await writeContract(wagmiConfig, {
        chainId: monad.id,
        address: market.borrowAsset.address,
        abi: APPROVE_ABI,
        functionName: "approve",
        args: [market.poolAddress, MAX_UINT256],
      });
      await waitForTransactionReceipt(wagmiConfig, { chainId: monad.id, hash: repayApproveTx });

      const repayTx = await writeContract(wagmiConfig, {
        chainId: monad.id,
        address: market.poolAddress,
        abi: AAVE_POOL_ABI,
        functionName: "repay",
        args: [market.borrowAsset.address, MAX_UINT256, 2n, address],
      });
      await waitForTransactionReceipt(wagmiConfig, { chainId: monad.id, hash: repayTx });

      setWithdrawPhase("sending it back to your wallet...");
      const withdrawTx = await writeContract(wagmiConfig, {
        chainId: monad.id,
        address: market.poolAddress,
        abi: AAVE_POOL_ABI,
        functionName: "withdraw",
        args: [market.collateralAsset.address, MAX_UINT256, address],
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
  const spread = market ? market.supplyApy - market.borrowApy : null;

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

          {position ? (
            <>
              <div style={{ marginTop: 24, fontSize: 26, letterSpacing: 1 }}>${position.borrowedFormatted}</div>
              <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>available to spend</div>
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <span style={{ fontSize: 10, border: `1px solid ${paper}`, padding: "4px 8px", opacity: 0.9 }}>[ native yield ]</span>
                <span style={{ fontSize: 10, border: `1px solid ${paper}`, padding: "4px 8px", opacity: 0.9 }}>[ tax-free spend ]</span>
              </div>
            </>
          ) : (
            <>
              <div style={{ marginTop: 24, fontSize: 22, letterSpacing: 2, opacity: 0.5 }}>•••• •••• •••• ••••</div>
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 8 }}>
                {!isConnected ? "connect a wallet to activate" : "deposit to activate your card"}
              </div>
            </>
          )}
        </div>
        <div style={{ fontSize: 10, color: gray, marginBottom: 20 }}>
          sandbox demo — Monad hackathon. no real card issuance in this build yet.
        </div>

        {/* controls */}
        <div style={{ border: `1px solid ${ink}`, background: paper, padding: 16 }}>
          {!isConnected && (
            <button
              className="mf-cta"
              onClick={() => open()}
              style={{ width: "100%", padding: "11px 0", border: `1px solid ${ink}`, background: "transparent", color: ink, fontFamily: "inherit", fontSize: 13, letterSpacing: 1, cursor: "pointer" }}
            >
              connect wallet
            </button>
          )}

          {isConnected && !position && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <div style={{ fontSize: 11, color: gray, fontWeight: 600 }}>deposit</div>
                <span onClick={() => setPickerOpen((v) => !v)} style={{ fontSize: 11, color: gray, cursor: "pointer", textDecoration: "underline" }}>
                  {pickedToken ? `${pickedToken.symbol} on ${POPULAR_TOKENS.find((p) => p.symbol === pickedToken.symbol && p.network === pickedToken.network)?.chainLabel}` : "[ choose a token ]"}
                </span>
              </div>

              {pickerOpen && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 12 }}>
                  {POPULAR_TOKENS.map((t) => {
                    const bal = balances[`${t.symbol}|${t.network}`];
                    const isActive = pickedToken?.symbol === t.symbol && pickedToken?.network === t.network;
                    return (
                      <span
                        key={`${t.symbol}|${t.network}`}
                        onClick={() => {
                          setPickedToken(t);
                          setAmount("");
                          setPickerOpen(false);
                        }}
                        style={{
                          fontSize: 12,
                          padding: "8px 10px",
                          border: `1px solid ${ink}`,
                          cursor: "pointer",
                          background: isActive ? ink : "transparent",
                          color: isActive ? paper : ink,
                        }}
                      >
                        {t.symbol} <span style={{ opacity: 0.7 }}>· {t.chainLabel}</span>
                        {bal !== undefined && bal > 0n && (
                          <div style={{ fontSize: 10, opacity: 0.7 }}>
                            {truncateDecimalString(formatUnits(bal, findTokenRecord(liveTokens, t.symbol, t.network)?.decimals ?? 18), 4)}
                          </div>
                        )}
                      </span>
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

              {(() => {
                const missingInput = !pickedToken || !amount || Number(amount) <= 0;
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
                        {!pickedToken ? "choose a token above first." : "enter an amount to deposit."}
                      </div>
                    )}
                  </>
                );
              })()}
              {depositStatus === "error" && depositError && <div style={{ fontSize: 11, color: "#B3261E", marginTop: 8 }}>{depositError}</div>}
              {marketStatus === "error" && <div style={{ fontSize: 11, color: "#B3261E", marginTop: 8 }}>could not load Aave's Monad market — try refreshing.</div>}
            </>
          )}

          {isConnected && position && (
            <>
              <div style={{ fontSize: 12, lineHeight: 1.8, marginBottom: 14 }}>
                <div>
                  supplied <strong>{position.suppliedFormatted} USDC</strong> · borrowed <strong>{position.borrowedFormatted} {market?.borrowAsset.symbol}</strong>
                </div>
                {spread !== null && (
                  <div style={{ color: gray }}>
                    earning {market.supplyApy.toFixed(2)}% · paying {market.borrowApy.toFixed(2)}% · {spread.toFixed(2)}% net
                  </div>
                )}
              </div>
              <button
                className="mf-cta"
                onClick={handleWithdraw}
                disabled={withdrawing}
                style={{
                  width: "100%",
                  padding: "11px 0",
                  border: `1px solid ${ink}`,
                  background: "transparent",
                  color: ink,
                  fontFamily: "inherit",
                  fontSize: 13,
                  letterSpacing: 1,
                  cursor: "pointer",
                  opacity: withdrawing ? 0.7 : 1,
                }}
              >
                {withdrawing ? withdrawPhase || "working..." : "withdraw to wallet"}
              </button>
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

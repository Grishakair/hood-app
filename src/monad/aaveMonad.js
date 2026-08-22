// Monad-only slice of the same live Aave v3.7 market data Borrow.jsx reads
// for the multi-chain aggregator — kept separate on purpose so this
// standalone hackathon-demo page never imports anything from the main app.
import { monad } from "@reown/appkit/networks";

const AAVE_GRAPHQL_URL = "https://api.v3.aave.com/graphql";

// Same allowlist/reasoning as Borrow.jsx's STABLE_BORROW_SYMBOLS: Monad has
// no ETH reserve worth borrowing, so the carry is "supply USDC, borrow
// whichever enabled stablecoin is currently cheapest" — maximizes the
// supply/borrow spread, which is the whole pitch.
const STABLE_BORROW_SYMBOLS = ["GHO", "USDT0", "USDT", "AUSD", "USDe", "mUSD", "DAI"];

export async function fetchMonadAaveMarket() {
  const query = `{ markets(request: { chainIds: [${monad.id}] }) { address chain { chainId } reserves { underlyingToken { symbol address decimals } usdExchangeRate supplyInfo { canBeCollateral maxLTV { value } apy { formatted } } borrowInfo { apy { formatted } borrowingState borrowCapReached availableLiquidity { amount { value } } } } } }`;

  const res = await fetch(AAVE_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error("could not reach Aave's API");
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);

  const markets = json.data.markets.filter((m) => m.chain.chainId === monad.id);
  let market, collateral, borrow;
  for (const m of markets) {
    const c = m.reserves.find((r) => r.underlyingToken.symbol === "USDC" && r.supplyInfo.canBeCollateral);
    const b = c
      ? m.reserves
          .filter(
            (r) =>
              r.underlyingToken.symbol !== c.underlyingToken.symbol &&
              STABLE_BORROW_SYMBOLS.includes(r.underlyingToken.symbol) &&
              r.borrowInfo?.borrowingState === "ENABLED" &&
              // "enabled" + plenty of liquidity still isn't enough — a
              // reserve can have both and still be maxed out on its own
              // separate borrowCap, which reverts with BorrowCapExceeded()
              // on every attempt regardless of the borrower's own limits.
              // Confirmed live: USDe reads ENABLED with $64M liquidity but
              // borrowCapReached true, and picking it as "cheapest" made
              // every borrow on this page fail 100% of the time.
              r.borrowInfo?.borrowCapReached !== true &&
              Number(r.borrowInfo?.availableLiquidity?.amount?.value) > 0
          )
          .sort((x, y) => Number(x.borrowInfo.apy.formatted) - Number(y.borrowInfo.apy.formatted))[0]
      : undefined;
    if (c && b) {
      market = m;
      collateral = c;
      borrow = b;
      break;
    }
  }
  if (!market) throw new Error("Aave's Monad market has no USDC/stablecoin pair right now");

  return {
    poolAddress: market.address,
    supplyApy: Number(collateral.supplyInfo.apy.formatted),
    borrowApy: Number(borrow.borrowInfo.apy.formatted),
    collateralAsset: {
      address: collateral.underlyingToken.address,
      decimals: collateral.underlyingToken.decimals,
      usdPrice: Number(collateral.usdExchangeRate),
      maxLtv: Number(collateral.supplyInfo.maxLTV.value),
    },
    borrowAsset: {
      address: borrow.underlyingToken.address,
      decimals: borrow.underlyingToken.decimals,
      symbol: borrow.underlyingToken.symbol,
      usdPrice: Number(borrow.usdExchangeRate),
      liquidity: Number(borrow.borrowInfo.availableLiquidity.amount.value),
    },
    // Every stablecoin reserve that *could* have been picked as "cheapest"
    // on some earlier visit — "cheapest right now" drifts as rates move,
    // so an old debt isn't guaranteed to be in whatever's cheapest today.
    // Withdraw probes these to find which one a wallet actually owes,
    // rather than assuming it's still this session's current pick.
    allBorrowCandidates: market.reserves
      .filter((r) => r.underlyingToken.symbol !== collateral.underlyingToken.symbol && STABLE_BORROW_SYMBOLS.includes(r.underlyingToken.symbol))
      .map((r) => ({ symbol: r.underlyingToken.symbol, address: r.underlyingToken.address, decimals: r.underlyingToken.decimals })),
  };
}

// Ground truth for "what does this wallet actually owe" — Aave's own API,
// not a guess based on whichever reserve looks cheapest today. Falls back
// to market.borrowAsset if the query comes back empty (no debt found, or
// the API hiccups) so a caller can still attempt something sane.
export async function fetchUserDebtAsset(market, userAddress) {
  try {
    const query = `query T($r: UserBorrowsRequest!) { userBorrows(request: $r) { currency { symbol } } }`;
    const res = await fetch(AAVE_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { r: { markets: [{ address: market.poolAddress, chainId: monad.id }], user: userAddress, orderBy: { debt: "DESC" } } },
      }),
    });
    const json = await res.json();
    const symbol = json?.data?.userBorrows?.[0]?.currency?.symbol;
    const match = symbol && [market.borrowAsset, ...market.allBorrowCandidates].find((c) => c.symbol === symbol);
    if (match) return match;
  } catch {
    // fall through to the default below
  }
  return market.borrowAsset;
}

export const AAVE_POOL_ABI = [
  {
    name: "getUserAccountData",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
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
  {
    name: "repay",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
];

// Aave's convention for "the full amount" on both repay() and withdraw() —
// passing this pulls/returns exactly the current debt/balance rather than
// a stale pre-computed number that's already wrong by the next block.
export const MAX_UINT256 = (1n << 256n) - 1n;

export const APPROVE_ABI = [
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

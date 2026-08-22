# hood

A minimal, monochrome front end over [NEAR Intents](https://docs.intents.aurora.dev/) (via Aurora
Intents Connect) for cross-chain swap, send, Aave borrowing, and a card funded straight out of an
on-chain yield position — built for the Monad hackathon.

No wallet backend, no custom contracts: everything talks directly to public/partner APIs
(Aurora Intents, Aave's own GraphQL API, Immersve's sandbox) from the client, with wagmi/Reown
AppKit for wallet connect + signing.

## Run locally

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`.

## What's live

- **Swap / Send** — cross-chain swap or send across 30+ chains via Aurora Intents, with an optional
  private mode (Confidential Intents) and a manual-deposit fallback for non-EVM origins.
- **Borrow** — aggregates live Aave v3 rates (`api.v3.aave.com/graphql`, no key needed) across
  Ethereum, Base, BNB Chain, Polygon, and **Monad**, bridges USDC collateral in if needed, then
  supplies + borrows in one click.
  - On the first four chains this borrows ETH (the classic "borrow against your bag" case).
  - On **Monad**, Aave v3.7 is a real, live deployment (not a fork) — so instead of ETH, it
    supplies USDC and borrows whichever *enabled stablecoin currently has the lowest APY*. Since
    Monad's supply APY has consistently run above every stablecoin's borrow APY (an early-protocol
    incentive effect), this is a one-shot, no-loop carry position: the spread between the two is
    passive yield that never needs re-supplying.
- **Card** — Immersve sandbox integration: SIWE login (ties the card to your wallet, not a shared
  identity), spending-prerequisites check, virtual card issuance, on-demand PAN/CVV reveal, and a
  "simulate payment" button that fires a real test authorization + clearing against Immersve's
  sandbox card network. Sandbox only — no real money moves.

The pitch: deposit from any chain, let it earn on Aave on Monad, and spend against that position
through the card — the collateral keeps earning while the card spends the borrowed spread.

## Env vars

Copy `.env` and set (all optional — the app runs without them, just with reduced functionality):

```
VITE_AURORA_API_KEY=...                       # aurora intents fee-free quotes (partners.near-intents.org)
VITE_IMMERSVE_BASE_URL=...                    # defaults to Immersve's sandbox, https://test.immersve.com
VITE_IMMERSVE_CLIENT_APPLICATION_ID=...       # defaults to Immersve's published public sandbox id
VITE_IMMERSVE_FUNDING_CHANNEL_ID=...          # ditto
VITE_IMMERSVE_CARD_PROGRAM_ID=...             # ditto
VITE_IMMERSVE_ACCOUNT_ID=...                  # ditto
```

The Immersve defaults are Immersve's own publicly-documented sandbox test credentials (shared,
revocable any time) — fine for a demo, but everyone using the same public docs shares that
identity pool. Get your own sandbox account from Immersve if you want a clean one.

## Known caveats

- A few Immersve endpoint paths (funding source, card, prerequisites, simulator — see
  `src/lib/immersve.js`) are inferred from Immersve's guide docs rather than a fetched OpenAPI
  spec. The login and PAN-reveal paths are confirmed correct; if another one 404s, it's a one-line
  fix, each call is isolated in its own function.
- The card's funding source is scoped to whatever network Immersve's sandbox funding channel
  actually runs on, not necessarily Monad directly — in production this would be backed by the
  same Aave position the Borrow tab opens.
- Leverage-loop (supply → borrow → re-supply) is intentionally not implemented — one-shot only, to
  avoid presenting a liquidation-risk strategy as if it were riskless.

## Deploying

Plain Vite app — any static host works:

```bash
npm run build
```

produces a `dist/` folder.

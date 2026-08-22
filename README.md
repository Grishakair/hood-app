# hood

Built for the Monad hackathon. Two things live in this repo:

1. **`/monad.html`** — the actual pitch: **Spend & Earn**, a standalone page (untouched by, and
   untouched from, the main app below). Connect any wallet, pick a popular token from any chain,
   deposit — it supplies into Aave v3.7 on Monad mainnet (a real, live deployment, not a fork) and
   borrows a cheaper stablecoin against it in one shot (no leverage loop) — then shows that
   position as spendable card balance.
2. **`/` (index.html)** — the original multi-chain app: cross-chain swap/send, and a Borrow tab
   that does the same Aave supply+borrow trick across five chains including Monad.

No wallet backend, no custom contracts: everything talks directly to public/partner APIs (Aurora
Intents, Aave's own GraphQL API, Immersve's sandbox) from the client, with wagmi/Reown AppKit for
wallet connect + signing.

## Run locally

```bash
npm install
npm run dev
```

Opens `index.html` at `http://localhost:5173`; the standalone page is at `/monad.html`.

## `/monad.html` — Spend & Earn

1. **Connect** any wallet (Reown AppKit — EVM chains; Tron addresses are accepted as a manual
   send-to-address flow since it's non-EVM).
2. **Pick a token** from a short list of popular ones across Monad, Base, Ethereum, Arbitrum, and
   Tron, and deposit. Anything not already on Monad routes through Aurora/NEAR Intents to convert
   into USDC there.
3. That USDC is **supplied to Aave v3.7 on Monad** (`getUserAccountData`/`supply`), then the
   **cheapest available stablecoin is borrowed against it** in the same flow (`borrow`,
   `interestRateMode: variable`) — one shot, no re-supply loop, so there's no liquidation spiral to
   manage.
4. The card shows that position's value as a spendable balance, plus the real, live Aave supply
   APY the collateral keeps earning the whole time.
5. **Withdraw** repays any debt (against whichever reserve Aave's own `userBorrows` API says the
   wallet actually owes — not a guess) and pulls the full collateral back out.

**The card itself is a demo placeholder, not a real Immersve card.** The plan was to wire real
Immersve sandbox card issuance (SIWE login → KYC → funding source → card → PAN reveal) behind the
eye icon. That's blocked: Immersve's published public sandbox `clientApplicationId` is hard-gated
behind `KYC_REQUIRED` on card creation, and there's no scriptable way past it — even their own
documented test-mode KYC bypass (a partner-conducted KYC statement with `middleName: "passall"`)
returns `403 FORBIDDEN` for this shared client regardless of payload correctness (confirmed via
direct API testing: valid schema, valid region, still forbidden — a permissions issue, not a data
one). A real card would need Immersve to manually approve a dedicated partner account. So the card
number/exp/cvv shown is a deterministic, clearly-fake placeholder derived from the wallet address
(never a real PAN) — everything else (the deposit, the Aave position, the balance, the APY) is
real, live, on Monad mainnet.

## `/` — the main app

- **Swap / Send** — cross-chain swap or send across 30+ chains via Aurora Intents, with an optional
  private mode (Confidential Intents) and a manual-deposit fallback for non-EVM origins.
- **Borrow** — aggregates live Aave v3 rates (`api.v3.aave.com/graphql`, no key needed) across
  Ethereum, Base, BNB Chain, Polygon, and Monad, bridges USDC collateral in if needed, then
  supplies + borrows in one click. On the first four chains this borrows ETH; on Monad it borrows
  whichever enabled stablecoin currently has the lowest APY, for the same one-shot carry as above.

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

The Immersve defaults are Immersve's own publicly-documented sandbox test credentials — see the
KYC caveat above for why they can't actually issue a card. `src/lib/immersve.js` still has the full
client (SIWE login, prerequisites, funding source, card, PAN reveal, payment simulation) wired and
ready for whenever a properly-approved partner clientApplicationId is available.

## Known caveats

- Leverage-loop (supply → borrow → re-supply) is intentionally not implemented — one-shot only, to
  avoid presenting a liquidation-risk strategy as if it were riskless.
- Monad charges gas on the *declared* gas limit, not actual usage, and its execution is
  asynchronous (a state read immediately after a receipt can see stale pre-tx state) — both
  `monad.html`'s deposit/withdraw flows account for this (tight `eth_estimateGas` + buffer, and a
  retry loop before reading post-tx state).

## Deploying

Plain Vite multi-page app (`index.html` + `monad.html`, see `vite.config.js`) — any static host
works:

```bash
npm run build
```

produces a `dist/` folder with both pages.

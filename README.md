# hood

Minimal swap/send interface on top of NEAR Intents. Toggle between swap and
send, with an optional private mode, in one flow.

## Run locally

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`.

## What's already wired up

- Full swap / send UI, matching the design we iterated on in chat
- Live token list: on load, the app calls the public 1Click endpoint
  `GET https://1click.chaindefuser.com/v0/tokens` (no API key needed) and
  shows real tokens + prices in the token picker. If the request fails for
  any reason, it falls back to a small demo list so the UI never breaks.
- All the interaction state (swap/send mode, private toggles, convert-for-
  recipient, slippage, token picker) is real React state — no mock buttons.

This part didn't work inside the claude.ai artifact preview because that
sandbox blocks outbound fetches to arbitrary domains. Running it here, as a
real page, that restriction goes away.

## What's next (not wired up yet)

1. **Wallet connection.** Nothing here can move real funds without it.
   - EVM chains: [wagmi](https://wagmi.sh/) + [viem](https://viem.sh/)
   - NEAR: [NEAR Wallet Selector](https://github.com/near/wallet-selector)
   - Aurora Labs also ships `@aurora-is-near/intents-swap-widget`, whose
     `hooks`/`machine` submodules can replace a lot of this by-hand plumbing
     if you'd rather not write the quote/deposit/status logic yourself.

2. **Real quotes.** Right now amounts don't produce a live quote yet. The
   next step is calling `POST https://1click.chaindefuser.com/v0/quote`
   with `dry: true` whenever the sell amount or token changes, and showing
   the estimated buy amount. This needs no wallet — just the two tokens and
   an amount.

3. **Executing a swap/send.** Once a real quote comes back with a
   `depositAddress`, the connected wallet needs to send funds there, then
   the app polls `GET /v0/status?depositAddress=...` until it's `SUCCESS`.
   This is the part where a private key ever touches a signature — get an
   API key first (https://partners.near-intents.org) so you're not paying
   the default 0.2% fee, and never put that key or a user's private key in
   client-side code that ends up in the browser bundle for anything beyond
   the JWT used for fee-free quotes.

4. **Private mode.** Confidential Intents currently supports transfers,
   deposits, and withdrawals — not swaps yet ("swaps coming soon" per NEAR's
   own docs as of this writing). So `send privately` can be made real now;
   `make swap private` should stay labeled as upcoming until NEAR ships
   confidential swaps, so the app doesn't promise something it can't do.

## Deploying

Any static host works since this is a plain Vite app:

```bash
npm run build
```

produces a `dist/` folder — drop it on Vercel, Netlify, or wherever you like.

npm install

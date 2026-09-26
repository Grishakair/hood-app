# Last Dance — custody & on-chain plan (draft, not decided)

**Status:** draft for discussion, nothing here is deployed or live. Written in response to "we probably need a smart contract for this" — this doc lays out what that would actually mean, the honest trust tradeoffs, and what has to happen *before* any of it touches real money. It does not make the legal or business call on whether to proceed — that's Grisha's to make, with a lawyer, not something to decide by writing code overnight.

Today, Last Dance is 100% virtual: balances live in `server/data.json`, a flat file on one machine, with no real deposits or withdrawals. Nothing below is live.

## The core problem a contract would actually solve

The risky part of "real money PvP" was never really "should the funds sit in a smart contract" — it's **who decides who won, and can that party be trusted (or checked) with real money on the line.** Determining the winner requires knowing live prices for whatever 20 tokens players picked over a 30-second window — that's an off-chain computation (`server/duelServer.js` reads Binance), not something a smart contract can verify cheaply or trustlessly on its own without a real price-and-basket oracle (see "What a fully trustless version would need," below).

So a smart contract here does **not** eliminate trust — it narrows *what* you have to trust down to one thing: **the resolver key can only pay out the exact pot to players who were actually in the match, and never more, and never to itself.** [`contracts/DuelEscrow.sol`](../contracts/DuelEscrow.sol) is a draft of that: players deposit into a match escrow on-chain, and the same backend that already computes results (`duelServer.js`) submits the winner/payout split, enforced on-chain to sum exactly to the deposited pot. If the resolver disappears or misbehaves, a timeout lets every player pull their own stake back — so the failure mode is "match stalls, everyone gets refunded," not "resolver walks off with the pot."

**This is meaningfully safer than the current model (a JSON file on one laptop)**, but it is explicitly **not** a trustless/provably-fair casino contract. Be honest about that distinction with users if this ever ships for real money — "your funds aren't in a company's spreadsheet, they're in an escrow contract that only pays out matching what was deposited" is a true, valuable claim; "this is provably fair / decentralized" would not be.

## Two models, compared

| | **A. Escrow smart contract** (the draft above) | **B. Custodial ledger** (today's model, extended with real deposits) |
|---|---|---|
| Where funds sit | On-chain, in a contract only the resolver can trigger payouts from | A hot wallet / exchange account Hood controls directly |
| What a hack gets an attacker | Whatever's mid-match in escrow at that moment (bounded, small, per-match) | Everything in the custodial wallet, all the time |
| What a compromised resolver key can do | Pay winners the wrong split among *actual match players* — cannot mint funds, cannot pay a non-player, cannot exceed the pot | Move all custodied user funds anywhere, arbitrarily |
| Engineering cost | Contract audit, key management for the resolver signer, gas costs per match (real money on every deposit/payout — needs an L2 or low-fee chain to make sense for $10 stakes) | Lower — closer to what exists today, but the "how do we not get hacked" problem is entirely about hot-wallet security practices, not solved by any code in this repo |
| Regulatory framing | Still real-money wagering on an outcome regardless of custody model — a contract does not change the legal question | Same |

**Recommendation if/when this becomes real:** (A) is the better security posture *if* real money is involved at all, specifically because it bounds the blast radius of a compromise to in-flight matches instead of the whole user balance pool. But (A) only matters once the legal question below is actually answered — building it first doesn't make the legal question go away.

## The question that has to be answered before either model, by Grisha + an actual lawyer, not by me

This product is two (or five) people staking money on whose basket of assets performs better over a fixed window. That is **wagering on an outcome with a monetary prize**, which is exactly the fact pattern that gambling law looks at — "skill vs. chance" arguments exist and vary a lot by jurisdiction (and by the specific players' jurisdictions, not just where Hood is based), but this needs a real answer from someone qualified before real funds are accepted from real users, not an assumption baked into the code. I'm flagging this clearly rather than quietly building payment rails as if it were settled — it isn't, and I'm not the one who can settle it.

Practical implication for anything I build in the meantime: keep it on testnet, keep entry "stakes" virtual, and don't wire this contract to a wallet holding real value until that legal review has happened.

## If it's decided to move forward: rough sequence

1. **Legal review** (above) — gates everything else.
2. **Contract audit** — `DuelEscrow.sol` is a first draft, not production code. At minimum: a second engineer's review, then a paid audit (even a lightweight one) before any non-trivial amount of real money touches it. Known things to revisit before that audit: gas cost of `resolveMatch` for 5 winners in a Battleground tie, whether `RESOLUTION_TIMEOUT` is long enough against real network congestion, and whether the resolver key should be a multisig instead of one EOA (a single compromised key single-handedly deciding every match's payout is the biggest remaining weak point).
3. **Resolver key management** — this key becomes as valuable as the total pot volume flowing through it. At minimum it should not be the same key/machine as the dev laptop currently running `duelServer.js` over an SSH tunnel (see [last_dance_project.md](../../.claude in the memory system, not in this repo) — that infra is explicitly ad-hoc and not meant to hold anything of value yet).
4. **Chain choice** — needs real per-match gas costs to pencil out against $10 stakes; this repo already has Monad testnet wiring (`src/monad/`), which is a reasonable place to prototype given the existing integration, but the final choice (Monad, an existing L2, etc.) is a cost/liquidity/user-familiarity tradeoff worth its own pass, not decided here.
5. **Anti-cheat**: multi-wallet self-play (one person controlling both "sides" of a match to launder funds or farm achievements) is not addressed by the escrow contract at all — that's a matchmaking/fraud-detection problem for `duelServer.js`, separate from custody.
6. Only then: testnet pilot with a handful of real users and small real stakes, monitored closely, before any wider rollout.

Nothing past step 1 should happen without that legal answer in hand.

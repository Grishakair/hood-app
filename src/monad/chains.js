// Chain metadata for the /monad page's own wagmi instance (./appkit.js) —
// kept separate from lib/shared.js's maps rather than extending them, since
// those back the old page and adding Arbitrum there would change what the
// old app's balance-scanning does too. This file is the only thing that
// needs to know about this page's chain list.
import { getAccount, switchChain } from "wagmi/actions";
import { mainnet, base, optimism, polygon, bsc, arbitrum, monad } from "@reown/appkit/networks";
import { wagmiConfig } from "./appkit.js";

export const EXPLORER_BY_CHAIN = {
  [mainnet.id]: "https://etherscan.io",
  [base.id]: "https://basescan.org",
  [optimism.id]: "https://optimistic.etherscan.io",
  [polygon.id]: "https://polygonscan.com",
  [bsc.id]: "https://bscscan.com",
  [arbitrum.id]: "https://arbiscan.io",
  [monad.id]: "https://monadscan.com",
};

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
  arbitrum: arbitrum.id,
  arb: arbitrum.id,
  monad: monad.id,
};

export const NATIVE_SYMBOL_BY_CHAIN = {
  [mainnet.id]: "ETH",
  [base.id]: "ETH",
  [optimism.id]: "ETH",
  [polygon.id]: "POL",
  [bsc.id]: "BNB",
  [arbitrum.id]: "ETH",
  [monad.id]: "MON",
};

export const CHAIN_NAME_BY_ID = {
  [mainnet.id]: "Ethereum",
  [base.id]: "Base",
  [optimism.id]: "Optimism",
  [polygon.id]: "Polygon",
  [bsc.id]: "BNB Chain",
  [arbitrum.id]: "Arbitrum",
  [monad.id]: "Monad",
};

export async function ensureChain(chainId) {
  if (getAccount(wagmiConfig).chainId === chainId) return;
  try {
    await switchChain(wagmiConfig, { chainId });
  } catch {
    const name = CHAIN_NAME_BY_ID[chainId] || `chain ${chainId}`;
    throw new Error(`switch your wallet to ${name} and try again`);
  }
}

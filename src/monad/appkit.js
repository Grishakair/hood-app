// A separate AppKit/Wagmi instance for the /monad page, deliberately not
// the one in ../config/appkit.js — that instance backs the existing app's
// index.html bundle, and this page needs a different chain list (adds
// Arbitrum) without changing what the old page connects to. The two never
// load in the same browser tab (separate Vite entries), so having two
// createAppKit() calls is safe.
import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { mainnet, base, optimism, polygon, bsc, arbitrum, monad } from "@reown/appkit/networks";

export const projectId = "a00f9a871b60104aeee70aeaf6d935a6";

export const networks = [mainnet, base, optimism, polygon, bsc, arbitrum, monad];

export const wagmiAdapter = new WagmiAdapter({
  networks,
  projectId,
});

createAppKit({
  adapters: [wagmiAdapter],
  networks,
  projectId,
  metadata: {
    name: "hood — monad",
    description: "Supply into Aave on Monad, borrow against it, spend the card.",
    url: window.location.origin,
    icons: [],
  },
  features: {
    analytics: false,
  },
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

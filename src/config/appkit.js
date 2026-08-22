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
    name: "hood",
    description: "Minimal swap/send interface on top of NEAR Intents",
    url: window.location.origin,
    icons: [],
  },
  features: {
    analytics: false,
  },
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

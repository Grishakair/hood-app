import React from "react";
import ReactDOM from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MonadFlow from "./monad/MonadFlow.jsx";
import { wagmiConfig } from "./config/appkit.js";
import "./index.css";

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <MonadFlow />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);

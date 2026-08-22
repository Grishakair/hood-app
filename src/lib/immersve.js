// Thin client for Immersve's sandbox API — SIWE login, spending
// prerequisites, funding source + card issuance, and the payment simulator.
// Card-holder-scoped calls (login, prerequisites, funding source, card,
// secure card info) all run off the bearer token from the user's own SIWE
// signature, never the account-admin key — that's what ties the resulting
// card to *this* wallet instead of Immersve's shared public identity. The
// admin key/secret only backs account-level plumbing (the funding channel
// itself), which the public sandbox account already has pre-provisioned.
//
// Some endpoint paths below (spending prerequisites, funding sources,
// cards, simulator) are inferred from Immersve's guide docs rather than a
// fetched OpenAPI spec — if one 404s during testing, check
// docs.immersve.com/api-reference for the exact path and fix it here; every
// call is isolated in its own function so a wrong path is a one-line fix.

const DEFAULT_BASE_URL = "https://test.immersve.com";
export const IMMERSVE_BASE_URL = import.meta.env.VITE_IMMERSVE_BASE_URL || DEFAULT_BASE_URL;

// Immersve publishes these on docs.immersve.com/resources/public-sandbox-account
// for anyone to test against — sandbox-only, no real funds, revocable at
// any time. Overridable via env if Immersve issues you your own.
export const IMMERSVE_CLIENT_APPLICATION_ID =
  import.meta.env.VITE_IMMERSVE_CLIENT_APPLICATION_ID || "d0b05d44204810fc61991a49e289dda3";
export const IMMERSVE_FUNDING_CHANNEL_ID =
  import.meta.env.VITE_IMMERSVE_FUNDING_CHANNEL_ID || "4cdc4310718674342d561647194e2446";
export const IMMERSVE_CARD_PROGRAM_ID =
  import.meta.env.VITE_IMMERSVE_CARD_PROGRAM_ID || "7dfa2e3ed390493ab307fac622f05ae9";
// Account-admin key — only used server-side-equivalent operations would
// need this (account/funding-channel management). The public sandbox
// channel above already exists, so nothing in this client actually needs
// to send it; kept here only in case a from-scratch funding channel setup
// is ever wired in.
export const IMMERSVE_ACCOUNT_ID = import.meta.env.VITE_IMMERSVE_ACCOUNT_ID || "d1bc97edfa4f7dc9b56726c7d82a9956";

async function request(path, { method = "GET", token, body, extraHeaders } = {}) {
  const res = await fetch(`${IMMERSVE_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = data?.message || data?.error || (typeof data === "string" ? data : null) || `${res.status} ${res.statusText}`;
    throw new Error(`Immersve ${method} ${path} failed: ${message}`);
  }
  return data;
}

// Step 1 of SIWE login — asks Immersve for the exact EIP-4361 message to sign.
export function siweLoginInit({ address, network = "monad" }) {
  return request("/auth/login-init", {
    method: "POST",
    body: {
      loginMethod: "siwe",
      network,
      clientApplicationId: IMMERSVE_CLIENT_APPLICATION_ID,
      scopes: ["cardholder-partner"],
      address,
      url: window.location.origin,
      autoSignup: true,
    },
  });
}

// Step 2 — hand back the wallet's signature over that exact message.
export function siweLoginComplete({ loginRequestId, signature }) {
  return request("/auth/login-complete", {
    method: "POST",
    body: { loginRequestId, signature },
  });
}

// What still stands between this wallet and a working card — KYC, contact
// details, etc. Each item carries its own actionType so the UI can render
// "what to do next" instead of a flat pass/fail.
export function getSpendingPrerequisites(token) {
  return request("/api/prerequisites", { token });
}

// Scopes a Funding Source under the pre-provisioned public sandbox Funding
// Channel to this cardholder — one per (wallet, funding channel) pair.
export function createFundingSource(token) {
  return request("/api/funding-sources", {
    method: "POST",
    token,
    body: { fundingChannelId: IMMERSVE_FUNDING_CHANNEL_ID },
  });
}

export function createCard(token, { fundingSourceId }) {
  return request("/api/cards", {
    method: "POST",
    token,
    body: { cardProgramId: IMMERSVE_CARD_PROGRAM_ID, fundingSourceId, formFactor: "virtual" },
  });
}

export function getCard(token, cardId) {
  return request(`/api/cards/${cardId}`, { token });
}

// Two-step reveal: this hands back a one-time callbackUrl, which the
// browser (only the browser — see the module comment) then GETs itself to
// receive PAN/expiry/CVV2. The callback URL 403s on a second use.
export async function getCardSecrets(token, cardId) {
  const { callbackUrl } = await request(`/api/cards/${cardId}/pan-token`, { method: "POST", token });
  const res = await fetch(callbackUrl);
  if (!res.ok) throw new Error(`could not fetch card details (${res.status})`);
  return res.json();
}

// Fires a fake authorization + immediate clearing against the sandbox card
// network — this is what "Simulate Payment" actually calls, no real rail
// involved (test.immersve.com only ever talks to Immersve's own simulator).
export async function simulatePayment(token, { cardId, amount, currency = "USD", merchantName = "Hood Demo Merchant" }) {
  const auth = await request("/api/simulator/authorizations", {
    method: "POST",
    token,
    body: { cardId, amount, currency, merchantName },
  });
  const clearing = await request("/api/simulator/clearings", {
    method: "POST",
    token,
    body: { authorizationId: auth.id, amount },
  });
  return { auth, clearing };
}

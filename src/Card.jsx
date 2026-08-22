import { useState } from "react";
import { signMessage } from "wagmi/actions";
import { wagmiConfig } from "./config/appkit.js";
import {
  siweLoginInit,
  siweLoginComplete,
  getSpendingPrerequisites,
  createFundingSource,
  createCard,
  getCard,
  getCardSecrets,
  simulatePayment,
} from "./lib/immersve.js";

// Small standalone mark — App.jsx has its own HoodMark but importing it
// here would create an App<->Card import cycle (App renders CardPanel),
// same reasoning as why lib/shared.js stays plain helpers instead of JSX.
function HoodMark({ size = 22, ink, paper }) {
  return (
    <svg width={size} height={size} viewBox="0 0 160 160" style={{ display: "block" }}>
      <path
        d="M 80 12 C 42 12 18 36 18 68 L 18 108 C 18 126 28 138 48 140 L 112 140 C 132 138 142 126 142 108 L 142 68 C 142 36 118 12 80 12 Z"
        fill={ink}
      />
      <circle cx="55" cy="78" r="16" fill={paper} />
      <circle cx="105" cy="78" r="16" fill={paper} />
    </svg>
  );
}

const PREREQ_ACTION_LABEL = {
  follow_kyc_url: "verify identity",
  submit_kyc_statement: "submit identity statement",
  submit_contact_email: "add contact email",
};

export default function CardPanel({ ink, gray, line, paper, isConnected, address, open }) {
  const [session, setSession] = useState(null); // { accessToken }
  const [loginStatus, setLoginStatus] = useState("idle"); // idle | signing | verifying | done | error
  const [loginError, setLoginError] = useState("");

  const [prereqs, setPrereqs] = useState(null);
  const [prereqStatus, setPrereqStatus] = useState("idle"); // idle | loading | ready | error

  const [card, setCard] = useState(null); // { id, status }
  const [issueStatus, setIssueStatus] = useState("idle"); // idle | running | done | error
  const [issueError, setIssueError] = useState("");
  const [issueLog, setIssueLog] = useState([]);

  const [secrets, setSecrets] = useState(null); // { pan, expiry, cvv2 }
  const [secretsStatus, setSecretsStatus] = useState("idle"); // idle | loading | shown | error
  const [revealed, setRevealed] = useState(false);

  const [simAmount, setSimAmount] = useState("5.00");
  const [simStatus, setSimStatus] = useState("idle"); // idle | running | done | error
  const [simError, setSimError] = useState("");
  const [simResult, setSimResult] = useState(null);

  function setLogStep(key, status, extra) {
    setIssueLog((log) => log.map((s) => (s.key === key ? { ...s, status, ...extra } : s)));
  }

  async function handleLogin() {
    if (!isConnected) {
      open();
      return;
    }
    try {
      setLoginError("");
      setLoginStatus("signing");
      const init = await siweLoginInit({ address, network: "monad" });
      const signature = await signMessage(wagmiConfig, { message: init.signingChallenge.message, account: address });
      setLoginStatus("verifying");
      const { accessToken } = await siweLoginComplete({ loginRequestId: init.id, signature });
      setSession({ accessToken });
      setLoginStatus("done");

      setPrereqStatus("loading");
      try {
        const list = await getSpendingPrerequisites(accessToken);
        setPrereqs(Array.isArray(list) ? list : list?.prerequisites || []);
        setPrereqStatus("ready");
      } catch (err) {
        setPrereqStatus("error");
        setPrereqs(null);
      }
    } catch (err) {
      setLoginStatus("error");
      setLoginError(err?.message || "SIWE login failed");
    }
  }

  const blockedByKyc = Boolean(
    prereqs?.some((p) => p.status && p.status !== "ok" && p.status !== "pending")
  );

  async function handleIssueCard() {
    if (!session) return;
    const steps = [
      { key: "fund", label: "create funding source", status: "pending" },
      { key: "card", label: "create card", status: "pending" },
      { key: "activate", label: "wait for card to activate", status: "pending" },
    ];
    setIssueLog(steps);
    setIssueError("");
    setIssueStatus("running");
    try {
      setLogStep("fund", "active");
      const fundingSource = await createFundingSource(session.accessToken);
      setLogStep("fund", "done");

      setLogStep("card", "active");
      const created = await createCard(session.accessToken, { fundingSourceId: fundingSource.id });
      setLogStep("card", "done");

      setLogStep("activate", "active");
      let current = created;
      for (let i = 0; i < 10 && current.status !== "active"; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        current = await getCard(session.accessToken, created.id);
      }
      setLogStep("activate", current.status === "active" ? "done" : "error", {
        detail: current.status === "active" ? undefined : `still "${current.status}" — try revealing details in a moment`,
      });
      setCard(current);
      setIssueStatus("done");
    } catch (err) {
      setIssueStatus("error");
      setIssueError(err?.message || "card issuance failed");
      setIssueLog((log) => log.map((s) => (s.status === "active" ? { ...s, status: "error" } : s)));
    }
  }

  async function handleReveal() {
    if (!session || !card) return;
    if (revealed) {
      setRevealed(false);
      return;
    }
    try {
      setSecretsStatus("loading");
      const data = await getCardSecrets(session.accessToken, card.id);
      setSecrets(data);
      setSecretsStatus("shown");
      setRevealed(true);
    } catch (err) {
      setSecretsStatus("error");
    }
  }

  async function handleSimulate() {
    if (!session || !card) return;
    try {
      setSimError("");
      setSimStatus("running");
      const result = await simulatePayment(session.accessToken, { cardId: card.id, amount: simAmount });
      setSimResult(result);
      setSimStatus("done");
    } catch (err) {
      setSimStatus("error");
      setSimError(err?.message || "simulated payment failed");
    }
  }

  const rowLabel = { fontSize: 11, color: gray, marginBottom: 6, fontWeight: 600 };
  const box = { border: `1px solid ${line}`, padding: 14, marginBottom: 14 };

  return (
    <div style={{ maxWidth: 380, margin: "0 auto", paddingBottom: 40 }}>
      <div className="hood-card-scale" style={{ border: `1px solid ${ink}`, background: paper, transformOrigin: "top center" }}>
        <div style={{ padding: 16 }}>
          <div style={{ fontSize: 11, color: gray, marginBottom: 14, lineHeight: 1.6 }}>
            spend straight from your Aave position on Monad — no cash-out, the collateral keeps earning while the card
            spends. sandbox only, test funds only.
          </div>

          {/* the card face */}
          <div
            style={{
              background: ink,
              color: paper,
              padding: "20px 18px",
              marginBottom: 14,
              fontFamily: "inherit",
              position: "relative",
              minHeight: 128,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <HoodMark size={24} ink={paper} paper={ink} />
              <div style={{ fontSize: 10, letterSpacing: 1, opacity: 0.7 }}>hood card</div>
            </div>
            <div style={{ marginTop: 26, fontSize: 17, letterSpacing: 2 }}>
              {secretsStatus === "shown" && revealed
                ? secrets?.pan?.replace(/(.{4})/g, "$1 ").trim()
                : card
                ? "•••• •••• •••• ••••"
                : "no card yet"}
            </div>
            <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", fontSize: 11, opacity: 0.85 }}>
              <span>{secretsStatus === "shown" && revealed ? `exp ${secrets?.expiry}` : "exp ••/••"}</span>
              <span>{secretsStatus === "shown" && revealed ? `cvv ${secrets?.cvv2}` : "cvv •••"}</span>
            </div>
          </div>

          {!session && (
            <>
              <div style={rowLabel}>step 1 — sign in with your wallet</div>
              <p style={{ fontSize: 11, color: gray, lineHeight: 1.6, marginTop: 0 }}>
                signs a one-time SIWE message (no gas, no transaction) so the card Immersve issues is tied to this
                wallet, not a shared login.
              </p>
              <button
                className="hood-cta"
                onClick={handleLogin}
                disabled={loginStatus === "signing" || loginStatus === "verifying"}
                style={{
                  width: "100%",
                  padding: "11px 0",
                  border: `1px solid ${ink}`,
                  background: "transparent",
                  color: ink,
                  fontFamily: "inherit",
                  fontSize: 13,
                  letterSpacing: 1,
                  cursor: "pointer",
                  marginBottom: 8,
                }}
              >
                {!isConnected
                  ? "connect wallet"
                  : loginStatus === "signing"
                  ? "confirm the signature in your wallet..."
                  : loginStatus === "verifying"
                  ? "verifying..."
                  : "sign in with wallet (SIWE)"}
              </button>
              {loginStatus === "error" && <div style={{ fontSize: 11, color: "#B3261E" }}>{loginError}</div>}
            </>
          )}

          {session && (
            <div style={box}>
              <div style={rowLabel}>spending prerequisites</div>
              {prereqStatus === "loading" && <div style={{ fontSize: 12, color: gray }}>checking KYC status...</div>}
              {prereqStatus === "error" && (
                <div style={{ fontSize: 12, color: gray }}>could not load prerequisites — try issuing a card anyway.</div>
              )}
              {prereqStatus === "ready" && (!prereqs || prereqs.length === 0) && (
                <div style={{ fontSize: 12, color: gray }}>nothing outstanding — sandbox identity is pre-cleared.</div>
              )}
              {prereqStatus === "ready" && prereqs && prereqs.length > 0 && (
                <div>
                  {prereqs.map((p, i) => (
                    <div key={i} style={{ fontSize: 12, padding: "4px 0", color: p.status === "ok" ? gray : ink }}>
                      [{p.status === "ok" ? "x" : " "}] {PREREQ_ACTION_LABEL[p.actionType] || p.actionType || p.stage}
                      {p.params?.kycUrl && (
                        <>
                          {" — "}
                          <a href={p.params.kycUrl} target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>
                            complete here
                          </a>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {session && !card && (
            <>
              <div style={rowLabel}>step 2 — issue a virtual card</div>
              <button
                className="hood-cta"
                onClick={handleIssueCard}
                disabled={issueStatus === "running" || blockedByKyc}
                style={{
                  width: "100%",
                  padding: "11px 0",
                  border: `1px solid ${ink}`,
                  background: "transparent",
                  color: ink,
                  fontFamily: "inherit",
                  fontSize: 13,
                  letterSpacing: 1,
                  cursor: blockedByKyc ? "default" : "pointer",
                  opacity: blockedByKyc ? 0.5 : 1,
                  marginBottom: 8,
                }}
              >
                {issueStatus === "running" ? "issuing..." : issueStatus === "error" ? "try again" : "issue virtual card"}
              </button>
              {blockedByKyc && (
                <div style={{ fontSize: 11, color: gray, marginBottom: 8 }}>finish the prerequisites above first.</div>
              )}
              {issueLog.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  {issueLog.map((s) => (
                    <div key={s.key} style={{ fontSize: 11, color: s.status === "error" ? "#B3261E" : gray, padding: "4px 0", borderTop: `1px solid ${line}` }}>
                      [{s.status === "done" ? "x" : s.status === "active" ? "." : s.status === "error" ? "!" : " "}] {s.label}
                      {s.detail ? ` — ${s.detail}` : ""}
                    </div>
                  ))}
                </div>
              )}
              {issueStatus === "error" && issueError && <div style={{ fontSize: 11, color: "#B3261E" }}>{issueError}</div>}
            </>
          )}

          {session && card && (
            <>
              <div style={rowLabel}>step 3 — card details</div>
              <button
                className="hood-cta"
                onClick={handleReveal}
                disabled={secretsStatus === "loading"}
                style={{
                  width: "100%",
                  padding: "11px 0",
                  border: `1px solid ${ink}`,
                  background: "transparent",
                  color: ink,
                  fontFamily: "inherit",
                  fontSize: 13,
                  letterSpacing: 1,
                  cursor: "pointer",
                  marginBottom: 14,
                }}
              >
                {secretsStatus === "loading" ? "fetching..." : revealed ? "hide card number" : "reveal card number"}
              </button>
              {secretsStatus === "error" && (
                <div style={{ fontSize: 11, color: "#B3261E", marginBottom: 14 }}>
                  could not fetch card details — the one-time reveal link may already be used; try again.
                </div>
              )}

              <div style={rowLabel}>step 4 — simulate a payment</div>
              <p style={{ fontSize: 11, color: gray, lineHeight: 1.6, marginTop: 0 }}>
                runs a fake authorization + clearing through Immersve's sandbox card network. no real merchant, no real
                money — this is what proves the card can actually spend.
              </p>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 1, borderBottom: `1px solid ${line}` }}>
                  <input
                    value={simAmount}
                    onChange={(e) => setSimAmount(e.target.value)}
                    className="hood-field"
                    style={{ border: "none", outline: "none", fontSize: 16, fontFamily: "inherit", background: "transparent", color: ink, width: "100%", padding: "6px 0" }}
                  />
                </div>
                <button
                  className="hood-cta"
                  onClick={handleSimulate}
                  disabled={simStatus === "running"}
                  style={{
                    padding: "0 16px",
                    border: `1px solid ${ink}`,
                    background: "transparent",
                    color: ink,
                    fontFamily: "inherit",
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  {simStatus === "running" ? "..." : "simulate"}
                </button>
              </div>
              {simStatus === "done" && simResult && (
                <div style={{ fontSize: 11, color: gray }}>
                  authorized + cleared ${simAmount} at {simResult.auth?.merchantName || "the test merchant"}.
                </div>
              )}
              {simStatus === "error" && simError && <div style={{ fontSize: 11, color: "#B3261E" }}>{simError}</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

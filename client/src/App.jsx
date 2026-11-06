
import { useEffect, useState } from "react";
import "./App.css";

async function api(path, options = {}) {
  let response;

  try {
    response = await fetch(`/api${path}`, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body
          ? { "Content-Type": "application/json" }
          : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new Error(
      "Cannot connect to SecurePay backend"
    );
  }

  const contentType =
    response.headers.get("content-type") || "";

  const raw = await response.text();

  let data = {};

  if (raw && contentType.includes("application/json")) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("Invalid JSON returned by backend");
    }
  }

  if (!response.ok) {
    throw new Error(
      data.message || `API request failed (${response.status})`
    );
  }

  if (!contentType.includes("application/json") || !raw) {
    throw new Error(
      `Expected JSON response from ${path}`
    );
  }

  return data;
}

function formatMoney(cents) {
  const value = BigInt(cents);
  const whole = value / 100n;
  const fraction = (value % 100n)
    .toString()
    .padStart(2, "0");

  return `LKR ${whole.toLocaleString("en-US")}.${fraction}`;
}

export default function App() {
  const [mode, setMode] = useState("login");
  const [user, setUser] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [csrf, setCsrf] = useState("");
  const [loading, setLoading] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [message, setMessage] = useState("");

  const [form, setForm] = useState({
    fullName: "",
    email: "",
    password: "",
  });

  const [transfer, setTransfer] = useState({
    receiverWalletId: "",
    amount: "",
  });

  async function loadWallet() {
    const data = await api("/wallet/me");
    setWallet(data);
  }

  useEffect(() => {
    let active = true;

    async function restore() {
      try {
        const me = await api("/auth/me");
        const token = await api("/auth/csrf");
        const walletData = await api("/wallet/me");

        if (active) {
          setUser(me.user);
          setCsrf(token.csrfToken);
          setWallet(walletData);
        }
      } catch {
        if (active) {
          setUser(null);
          setWallet(null);
          setCsrf("");
        }
      } finally {
        if (active) {
          setInitializing(false);
        }
      }
    }

    restore();

    return () => {
      active = false;
    };
  }, []);

  async function submitAuth(event) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    try {
      const body = mode === "register"
        ? form
        : {
            email: form.email,
            password: form.password,
          };

      const data = await api(
        mode === "register"
          ? "/auth/register"
          : "/auth/login",
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );

      const walletData = await api("/wallet/me");

      setUser(data.user);
      setCsrf(data.csrfToken);
      setWallet(walletData);
      setForm({
        fullName: "",
        email: "",
        password: "",
      });
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function sendMoney(event) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    try {
      const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/
        .exec(transfer.amount);

      if (!match) {
        throw new Error(
          "Enter a valid amount such as 125.50"
        );
      }

      const cents = (
        BigInt(match[1]) * 100n +
        BigInt((match[2] || "").padEnd(2, "0") || "0")
      ).toString();

      const result = await api("/wallet/transfer", {
        method: "POST",
        headers: { "x-csrf-token": csrf },
        body: JSON.stringify({
          receiverWalletId: transfer.receiverWalletId,
          amountCents: cents,
          idempotencyKey: crypto.randomUUID(),
        }),
      });

      setMessage(
        `Transfer successful: ${result.transferId}`
      );

      setTransfer({
        receiverWalletId: "",
        amount: "",
      });

      await loadWallet();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    try {
      await api("/auth/logout", {
        method: "POST",
        headers: { "x-csrf-token": csrf },
        body: JSON.stringify({}),
      });

      setUser(null);
      setWallet(null);
      setCsrf("");
      setMessage("");
    } catch (error) {
      setMessage(error.message);
    }
  }

  if (initializing) {
    return (
      <main className="page">
        <p>Checking SecurePay session...</p>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="dashboard">
        <header className="header">
          <div className="brand">
            <span className="brand-icon">S</span>
            <span>SecurePay</span>
          </div>
          <span className="demo-tag">DEMO MODE</span>
        </header>

        {!user ? (
          <section className="status-card">
            <h1>
              {mode === "register"
                ? "Create Account"
                : "Welcome Back"}
            </h1>

            <p>Secure Digital Wallet</p>

            <form onSubmit={submitAuth}>
              {mode === "register" && (
                <input
                  placeholder="Full Name"
                  autoComplete="name"
                  value={form.fullName}
                  onChange={(e) => setForm({
                    ...form,
                    fullName: e.target.value,
                  })}
                  required
                />
              )}

              <input
                type="email"
                placeholder="Email Address"
                autoComplete="email"
                value={form.email}
                onChange={(e) => setForm({
                  ...form,
                  email: e.target.value,
                })}
                required
              />

              <input
                type="password"
                placeholder="Password"
                minLength={mode === "register" ? 12 : 1}
                autoComplete={
                  mode === "register"
                    ? "new-password"
                    : "current-password"
                }
                value={form.password}
                onChange={(e) => setForm({
                  ...form,
                  password: e.target.value,
                })}
                required
              />

              <button disabled={loading}>
                {loading
                  ? "Processing..."
                  : mode === "register"
                    ? "Create Account"
                    : "Login"}
              </button>
            </form>

            <button
              className="secondary"
              onClick={() => {
                setMode(
                  mode === "login" ? "register" : "login"
                );
                setMessage("");
              }}
            >
              {mode === "login"
                ? "Create a new account"
                : "Already have an account? Login"}
            </button>
          </section>
        ) : (
          <>
            <section className="status-card">
              <div className="status-row">
                <h2>Hello, {user.full_name}</h2>
                <button
                  className="small-button"
                  onClick={logout}
                >
                  Logout
                </button>
              </div>

              <p>{user.email}</p>

              <div className="balance-box">
                <span>Available Demo Balance</span>
                <h1>
                  {wallet
                    ? formatMoney(wallet.balanceCents)
                    : "Loading..."}
                </h1>
                <small>
                  Wallet ID: {wallet?.walletId}
                </small>
              </div>

              <button
                className="secondary"
                onClick={loadWallet}
              >
                Refresh Balance
              </button>
            </section>

            <section className="status-card">
              <h2>Send Demo Money</h2>
              <p>
                Local development transfers only.
                Do not use real funds.
              </p>

              <form onSubmit={sendMoney}>
                <input
                  placeholder="Receiver Wallet UUID"
                  value={transfer.receiverWalletId}
                  onChange={(e) => setTransfer({
                    ...transfer,
                    receiverWalletId: e.target.value,
                  })}
                  required
                />

                <input
                  placeholder="Amount (LKR), e.g. 100.00"
                  value={transfer.amount}
                  onChange={(e) => setTransfer({
                    ...transfer,
                    amount: e.target.value,
                  })}
                  required
                />

                <button disabled={loading}>
                  {loading ? "Processing..." : "Send Demo Money"}
                </button>
              </form>
            </section>
          </>
        )}

        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}

        <footer>
          SecurePay © 2026 · Educational Prototype
        </footer>
      </div>
    </main>
  );
}

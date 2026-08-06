import { useState } from "react";
import { useRouter } from "next/router";
import Head from "next/head";

export default function Login() {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        router.replace("/");
      } else {
        const j = await res.json().catch(() => ({}));
        setError(j.error || "Incorrect PIN");
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Head>
        <title>Sign in · Watch Deal Finder</title>
      </Head>
      <main className="flex min-h-screen items-center justify-center px-4">
        <form
          onSubmit={submit}
          className="w-full max-w-sm rounded-2xl border border-border bg-card p-6"
        >
          <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
            Watch Deal Finder
          </p>
          <h1 className="mb-6 text-xl font-semibold">Enter PIN</h1>
          <input
            type="password"
            inputMode="numeric"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
            className="mb-3 w-full rounded-xl border border-border bg-background px-4 py-2.5 font-mono tabular-nums outline-none focus:border-brand"
          />
          {error && <p className="mb-3 text-sm text-[#e11d48]">{error}</p>}
          <button
            type="submit"
            disabled={busy || !pin}
            className="w-full rounded-xl bg-brand px-4 py-2.5 font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
          >
            {busy ? "Checking…" : "Unlock dashboard"}
          </button>
        </form>
      </main>
    </>
  );
}

/** The payer page: quote, sign one gasless USDC authorization, watch the Lightning payout land. */
export const payerPage = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>USDC to Lightning</title>
<style>
  :root {
    --bg: #f7f6f3; --panel: #ffffff; --text: #1c1b19; --muted: #6b6760; --line: #e4e1da;
    --accent: #f45d3c; --accent-text: #ffffff; --ok: #1f7a4d; --bad: #b3261e; --code: #f1efe9;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #141312; --panel: #1d1c1a; --text: #f1efe9; --muted: #a29d94; --line: #33312d;
      --accent: #ff7a5c; --accent-text: #1c1b19; --ok: #5fcf95; --bad: #ff8a80; --code: #262421; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 560px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 26px; line-height: 1.2; margin: 0 0 6px; letter-spacing: -0.02em; }
  .lede { color: var(--muted); margin: 0 0 24px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 20px; margin-bottom: 16px; }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  .row { display: flex; gap: 8px; }
  input, select { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line);
    border-radius: 10px; padding: 10px 12px; min-width: 0; }
  input { flex: 1; }
  button { font: inherit; font-weight: 650; border: 0; border-radius: 10px; padding: 11px 16px; cursor: pointer;
    background: var(--accent); color: var(--accent-text); }
  button.secondary { background: transparent; color: var(--text); border: 1px solid var(--line); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .muted { color: var(--muted); font-size: 14px; }
  .big { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 14px 0 0; font-size: 14px; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: 1px 5px; border-radius: 5px; }
  ol.steps { list-style: none; padding: 0; margin: 0; }
  ol.steps li { padding: 6px 0 6px 28px; position: relative; color: var(--muted); }
  ol.steps li::before { content: ""; position: absolute; left: 6px; top: 13px; width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--line); }
  ol.steps li.done { color: var(--text); }
  ol.steps li.done::before { background: var(--ok); border-color: var(--ok); }
  ol.steps li.now::before { border-color: var(--accent); }
  .error { color: var(--bad); }
  #outcome, #error, #account { overflow-wrap: anywhere; }
  .ok { color: var(--ok); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>USDC on Base → sats over Lightning</h1>
  <p class="lede" id="lede">Loading the solver…</p>

  <section class="panel">
    <label for="amount">Amount</label>
    <div class="row">
      <input id="amount" inputmode="decimal" placeholder="10.00" autocomplete="off">
      <select id="side" aria-label="Amount unit">
        <option value="from">USDC to send</option>
        <option value="to">sats to deliver</option>
      </select>
    </div>
    <p class="muted" id="rate"></p>
    <div class="actions">
      <button id="connect" class="secondary" type="button">Connect wallet</button>
      <button id="quote" type="button" disabled>Get quote</button>
    </div>
    <p class="muted" id="account"></p>
    <p class="error" id="error" role="alert"></p>
  </section>

  <section class="panel" id="quoteBox" hidden>
    <div class="big" id="summary"></div>
    <p class="muted" id="expiry"></p>
    <dl id="details"></dl>
    <div class="actions">
      <button id="sign" type="button">Sign &amp; send (no gas)</button>
    </div>
    <p class="muted">Your USDC is locked to the invoice's payment hash. The solver can only take it by proving the Lightning address was paid; otherwise it comes back to you.</p>
  </section>

  <section class="panel" id="progressBox" hidden>
    <ol class="steps" id="steps"></ol>
    <p id="outcome"></p>
  </section>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const STEPS = [
    ["quoted", "Quote ready"],
    ["locked", "USDC locked on Base"],
    ["paying", "Paying the invoice out of Arkade"],
    ["paid", "Lightning address paid"],
    ["settled", "USDC claimed with the preimage"],
  ];
  let info, account, quote, poll, submitted = false;

  const show = (el, on) => { el.hidden = !on; };
  const fail = (msg) => { $("error").textContent = msg || ""; };
  const hex32 = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  const usdc = (units) => (Number(units) / 1e6).toFixed(2);
  const sats = (n) => Number(n).toLocaleString("en-US");
  const explorer = (hash) => info && info.chain_id === 8453 && /^0x[0-9a-fA-F]{64}$/.test(hash) ? "https://basescan.org/tx/" + hash : null;

  function addDetail(dl, term, value, href) {
    const dt = document.createElement("dt"); dt.textContent = term;
    const dd = document.createElement("dd");
    if (href) { const a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = value; dd.append(a); }
    else { const code = document.createElement("code"); code.textContent = value; dd.append(code); }
    dl.append(dt, dd);
  }

  async function load() {
    const res = await fetch("/v1/info");
    info = await res.json();
    $("lede").textContent = "Lock USDC on Base and " + info.lightning_address + " receives sats over Lightning, paid from the solver's bitcoin within Arkade.";
    if (info.price && info.price.usd_per_btc) {
      const perUsdc = 1e8 / info.price.usd_per_btc * (1 - info.spread_bps / 10000);
      $("rate").textContent = "≈ " + Math.floor(perUsdc).toLocaleString("en-US") + " sats per USDC before the Lightning fee · payouts " +
        sats(info.min_payout_sats) + "–" + sats(info.max_payout_sats) + " sats";
    }
  }

  async function connect() {
    fail();
    if (!window.ethereum) return fail("No browser wallet found. Use \`pnpm pay\` from the repository instead.");
    [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
    const chainId = "0x" + Number(info.chain_id).toString(16);
    if ((await window.ethereum.request({ method: "eth_chainId" })) !== chainId) {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    }
    $("account").textContent = "Paying from " + account;
    $("quote").disabled = false;
  }

  async function requestQuote() {
    fail(); show($("quoteBox"), false);
    const side = $("side").value;
    const raw = $("amount").value.trim();
    if (!/^\\d+(\\.\\d+)?$/.test(raw)) return fail("Enter an amount.");
    const amount = side === "from" ? String(Math.round(Number(raw) * 1e6)) : String(Math.round(Number(raw)));
    const res = await fetch("/v1/swap", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, type: "rfq_request", rfq_id: hex32(), pair: info.pair, amount_side: side, amount, profile: { refund_address: account } }),
    });
    const body = await res.json();
    if (body.type !== "rfq_quote") return fail("Declined: " + (body.message || body.reason || body.error));
    quote = body;
    submitted = false;
    show($("sign"), true);
    show($("progressBox"), false);
    $("summary").textContent = "Lock " + usdc(quote.from_amount) + " USDC → " + sats(quote.to_amount) + " sats to " + quote.profile.lightning_address;
    const dl = $("details"); dl.replaceChildren();
    addDetail(dl, "Payment hash", quote.profile.payment_hash);
    addDetail(dl, "HTLC", quote.profile.htlc_address);
    addDetail(dl, "Refund opens", new Date(quote.profile.timelock * 1000).toLocaleString() + " (only if unpaid)");
    addDetail(dl, "Invoice", quote.profile.invoice.slice(0, 32) + "…");
    show($("quoteBox"), true);
    tickExpiry();
  }

  function tickExpiry() {
    if (!quote || submitted) return;
    const left = quote.valid_until - Math.floor(Date.now() / 1000);
    $("expiry").textContent = left > 0 ? "Quote valid for " + Math.floor(left / 60) + "m " + (left % 60) + "s" : "Quote expired — request a new one.";
    $("sign").disabled = left <= 0;
    if (left > 0) setTimeout(tickExpiry, 1000);
  }

  async function sign() {
    fail();
    $("sign").disabled = true;
    try {
      const signature = await window.ethereum.request({
        method: "eth_signTypedData_v4", params: [account, JSON.stringify(quote.profile.authorization.typed_data)],
      });
      const res = await fetch(quote.profile.authorization.submit, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "the solver refused the signature");
      submitted = true;
      show($("sign"), false);
      $("expiry").textContent = "Signed. The solver submitted your lock.";
      show($("progressBox"), true);
      const dl = $("details");
      addDetail(dl, "Lock transaction", body.tx_hash, explorer(body.tx_hash));
      follow();
    } catch (e) {
      fail(e.message || String(e));
      $("sign").disabled = false;
    }
  }

  function render(status) {
    const order = STEPS.map((s) => s[0]);
    let at = order.indexOf(status.state);
    const live = at >= 0 && status.state !== "settled";
    if (at < 0) {
      // cancelled or expired: show how far the order got
      const p = status.profile;
      at = p.arkade_swap_id ? 2 : p.lock_tx ? 1 : 0;
    }
    const list = $("steps"); list.replaceChildren();
    STEPS.forEach(([state, text], i) => {
      const li = document.createElement("li");
      li.textContent = text;
      if (i <= at) li.className = "done";
      else if (live && i === at + 1) li.className = "now";
      list.append(li);
    });
    const out = $("outcome");
    if (status.state === "settled") {
      out.className = "ok";
      out.textContent = "Done. Proof of payment (invoice preimage): " + status.profile.preimage;
    } else if (status.state === "cancelled") {
      out.className = "error";
      out.textContent = "Not paid: " + (status.profile.note || "declined") + ". Your USDC is returned" + (status.profile.return_tx ? " in " + status.profile.return_tx : "") + ".";
    } else if (status.state === "expired") {
      out.className = "muted"; out.textContent = "The quote expired before the lock landed.";
    } else { out.className = "muted"; out.textContent = ""; }
    return ["settled", "cancelled"].includes(status.state);
  }

  function follow() {
    clearInterval(poll);
    poll = setInterval(async () => {
      const res = await fetch("/v1/rfq/" + quote.rfq_id);
      if (res.ok && render(await res.json())) clearInterval(poll);
    }, 2500);
  }

  $("connect").addEventListener("click", () => connect().catch((e) => fail(e.message)));
  $("quote").addEventListener("click", () => requestQuote().catch((e) => fail(e.message)));
  $("sign").addEventListener("click", sign);
  load().catch((e) => fail("Could not reach the solver: " + e.message));
})();
</script>
</body>
</html>`;

/**
 * Lightning-address checks against a real Wallet of Satoshi response for gringo@walletofsatoshi.com
 * (recorded 2026-11-13; the invoice is for 1,000 sats and was never paid).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeInvoice } from "../src/lightning/invoice.js";
import { requestInvoice, resolveLightningAddress, verifyInvoice } from "../src/lightning/lnurl.js";

const PAY_REQUEST = {
  callback: "https://livingroomofsatoshi.com/api/v1/lnurl/payreq/4357c239-2f41-4b59-a987-9fcd3d1b661e",
  maxSendable: 100000000000,
  minSendable: 1000,
  metadata: '[["text/plain","Wallet of Satoshi: gringo"],["text/identifier","gringo@walletofsatoshi.com"]]',
  commentAllowed: 255,
  tag: "payRequest",
  allowsNostr: true,
  nostrPubkey: "be1d89794bf92de5dd64c1e60f6a2c70c140abac9932418fee30c5c637fe9479",
};
const INVOICE =
  "lnbc10u1p40wn8mpp5sdn5uul3mvugreqs6wz322hpdh0speg9nlrlmzd3zq6m86d8ry3shp57kqnkf9dpjqsnjal8a7krpxgwd5ve4cu4tjkm36nj2eue2x3g9sscqzzsxqyz5vqsp5v78tqhhlnzl9l8uew7eya6wewyyvsfcj44dj6kyeq80z6t8c07xq9qxpqysgqca2kw5tn05g7pevlau7ytlm457nyulpfs445xx87qcmvs5lxg5csqy08qyfthcrs65nvq506g0evwkrx0gr6qa29rcdml3a46trgfdgpl0alrw";
const CREATED = 1794591995;
const atCreation = () => CREATED + 60;

/** A fetch that answers the two LNURL requests and records the URLs asked for. */
const fakeFetch = (overrides: { payRequest?: object; invoice?: object } = {}) => {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    const body = url.includes("/.well-known/lnurlp/")
      ? { ...PAY_REQUEST, ...overrides.payRequest }
      : { pr: INVOICE, routes: [], ...overrides.invoice };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, urls };
};

describe("Lightning address (LUD-16 / LUD-06)", () => {
  it("decodes the invoice", () => {
    const invoice = decodeInvoice(INVOICE);
    assert.equal(invoice.bech32Prefix, "bc");
    assert.equal(invoice.amountMsat, 1_000_000n);
    assert.equal(invoice.paymentHash, "83674e73f1db3881e410d385152ae16ddf00e5059fc7fd89b11035b3e9a71923");
    assert.equal(invoice.timestamp, CREATED);
    assert.equal(invoice.expiresAt, CREATED + 86_400);
  });

  it("resolves the address and fetches an invoice that commits to its metadata", async () => {
    const { fetchImpl, urls } = fakeFetch();
    const payRequest = await resolveLightningAddress("Gringo@WalletOfSatoshi.com", fetchImpl);
    assert.equal(payRequest.address, "gringo@walletofsatoshi.com");
    assert.equal(urls[0], "https://walletofsatoshi.com/.well-known/lnurlp/gringo");
    const invoice = await requestInvoice(payRequest, 1_000n, { comment: "hello", now: atCreation }, fetchImpl);
    assert.equal(invoice.amountSats, 1_000n);
    assert.equal(invoice.lightningAddress, "gringo@walletofsatoshi.com");
    const callback = new URL(urls[1]!);
    assert.equal(callback.searchParams.get("amount"), "1000000");
    assert.equal(callback.searchParams.get("comment"), "hello");
  });

  it("refuses an invoice for another amount, another payee, or too little time", async () => {
    const { fetchImpl } = fakeFetch();
    const payRequest = await resolveLightningAddress("gringo@walletofsatoshi.com", fetchImpl);
    assert.throws(() => verifyInvoice(payRequest, INVOICE, 2_000n, { now: atCreation }), /does not match/);
    const otherMetadata = { ...payRequest, metadata: '[["text/plain","someone else"],["text/identifier","gringo@walletofsatoshi.com"]]' };
    assert.throws(() => verifyInvoice(otherMetadata, INVOICE, 1_000n, { now: atCreation }), /description hash/);
    assert.throws(() => verifyInvoice(payRequest, INVOICE, 1_000n, { now: () => CREATED + 86_401 }), /expired/);
    assert.throws(
      () => verifyInvoice(payRequest, INVOICE, 1_000n, { now: atCreation, validUntilAtLeast: CREATED + 90_000 }),
      /expires at/,
    );
  });

  it("refuses endpoints that are not a payRequest for that address", async () => {
    await assert.rejects(resolveLightningAddress("gringo@walletofsatoshi.com", fakeFetch({ payRequest: { tag: "withdrawRequest" } }).fetchImpl), /not an LNURL-pay/);
    await assert.rejects(
      resolveLightningAddress("gringo@walletofsatoshi.com", fakeFetch({ payRequest: { metadata: '[["text/plain","x"],["text/identifier","mallory@walletofsatoshi.com"]]' } }).fetchImpl),
      /does not identify/,
    );
    await assert.rejects(resolveLightningAddress("gringo@walletofsatoshi.com", fakeFetch({ payRequest: { status: "ERROR", reason: "no such user" } }).fetchImpl), /no such user/);
    await assert.rejects(resolveLightningAddress("not an address", fakeFetch().fetchImpl), /not a Lightning address/);
    const { fetchImpl } = fakeFetch();
    const payRequest = await resolveLightningAddress("gringo@walletofsatoshi.com", fetchImpl);
    await assert.rejects(requestInvoice(payRequest, 0n, {}, fetchImpl), /accepts/);
  });
});

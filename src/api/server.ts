/**
 * The solver's HTTP face. RFQ messages use the reference service's HTTP transport:
 *
 *   POST /v1/swap                     rfq_request -> rfq_quote, or rfq_refusal with a 4xx
 *   GET  /v1/rfq/:rfq_id              rfq_status; 404 means no status
 *   POST /v1/rfq/:rfq_id/authorization  the payer's EIP-3009 signature; the solver submits the lock
 *   GET  /v1/info                     market, limits, addresses, price and inventory
 *   GET  /                            a page that walks a payer through it with a browser wallet
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { log } from "../log.js";
import { HttpError, Refusal, type SolverEngine } from "../solver/engine.js";
import { payerPage } from "./page.js";

const MAX_BODY = 64 * 1024;

const readJson = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "request body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } catch {
        reject(new HttpError(400, "the body is not JSON"));
      }
    });
    req.on("error", reject);
  });

const send = (res: ServerResponse, status: number, body: string, type: string) => {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
};
const json = (res: ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body), "application/json");

/** A small fixed-window limiter: quotes cost the solver an invoice and an RFQ round trip each. */
class RateLimiter {
  private readonly hits = new Map<string, { count: number; reset: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.reset <= now) {
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

export interface ApiOptions {
  info(): Promise<Record<string, unknown>>;
  quotesPerMinute?: number;
}

export function createApi(engine: SolverEngine, options: ApiOptions): Server {
  const limiter = new RateLimiter(options.quotesPerMinute ?? 12, 60_000);
  const globalLimiter = new RateLimiter((options.quotesPerMinute ?? 12) * 10, 60_000);
  const page = payerPage();

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://solver.local");
    try {
      if (req.method === "OPTIONS") return send(res, 204, "", "text/plain");
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, page, "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/v1/info") return json(res, 200, await options.info());

      if (req.method === "POST" && url.pathname === "/v1/swap") {
        const body = await readJson(req);
        const rfqId = typeof (body as { rfq_id?: unknown })?.rfq_id === "string" ? (body as { rfq_id: string }).rfq_id : "";
        if (!limiter.allow(req.socket.remoteAddress ?? "unknown") || !globalLimiter.allow("all")) {
          return json(res, 429, new Refusal("rate_limited", "too many quote requests; try again in a minute").toMessage(rfqId));
        }
        try {
          return json(res, 200, await engine.quote(body));
        } catch (err) {
          if (err instanceof Refusal) return json(res, 422, err.toMessage(rfqId));
          throw err;
        }
      }

      const match = /^\/v1\/rfq\/([0-9a-f]{64})(\/authorization)?$/.exec(url.pathname);
      if (match && req.method === "GET" && !match[2]) {
        const status = engine.status(match[1]!);
        return status ? json(res, 200, status) : json(res, 404, { error: "unknown rfq_id" });
      }
      if (match && req.method === "POST" && match[2]) {
        return json(res, 200, await engine.relayAuthorization(match[1]!, await readJson(req)));
      }
      return json(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      log.error("request failed", { path: url.pathname, err });
      return json(res, 500, { error: "internal error" });
    }
  });
}

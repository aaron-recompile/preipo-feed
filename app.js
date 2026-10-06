// PreIPO metrics feed: structured, sourced, verification-graded numbers for private AI companies.
// Paid via x402 (USDC on Base), settled through the CDP facilitator so routes are listed in the x402 Bazaar.
import express from "express";
import { readFileSync } from "node:fs";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { facilitator } from "@coinbase/x402"; // reads CDP_API_KEY_ID / CDP_API_KEY_SECRET

const PAY_TO = "0x4b5887B6E399C2E104becd01f7c406229c15891d";
const MAKER = {
  name: "Aaron Zhang",
  role: "independent developer",
  url: "https://farcaster.xyz/aaronzhang",
};
const SERVICE_NAME = "PreIPO Feed by Aaron Zhang"; // Bazaar serviceName: printable ASCII, <= 32 chars
const NETWORKS = (process.env.X402_NETWORKS || "eip155:84532").split(",");
const load = (f) => JSON.parse(readFileSync(new URL(`./data/${f}`, import.meta.url)));

// One entry per paid dataset. The description is what Bazaar search matches on.
const PRODUCTS = [
  {
    card: load("anthropic.json"), price: "0.01", tags: ["anthropic", "pre-ipo", "revenue", "valuation", "fundamentals", "compute", "ai"],
    description:
      "Anthropic pre-IPO fundamentals as JSON: FY2025 revenue and May 2026 run-rate revenue, operating expenses, operating and net loss, compute and infrastructure spend, compute obligations, cash and short-term investments, top-customer revenue share, compute cost per revenue dollar. Each number has its own source URL, verification grade and value type (approx, lower bound, exact, derived).",
  },
  {
    card: load("openai.json"), price: "0.01", tags: ["openai", "pre-ipo", "revenue", "valuation", "fundamentals", "funding", "ai"],
    description:
      "OpenAI pre-IPO fundamentals as JSON: FY2025 revenue, monthly revenue, ChatGPT users and subscribers, March 2026 round size and post-money valuation, new round target and valuation in talks, SoftBank bond financing and stake, valuation-to-run-rate multiple. Each number has its own source URL, verification grade and value type.",
  },
  {
    card: load("anthropic-ipo.json"), price: "0.01", tags: ["anthropic", "ipo", "pre-ipo", "valuation", "underwriters", "timeline", "ai"],
    description:
      "Anthropic IPO data as JSON: filing status (confidential draft S-1), expected timing and listing window, target valuation range, expected proceeds, lead underwriters, last private round (Series H) size and valuation, run-rate revenue, valuation multiples, dated timeline. Each item has its own source URL and verification grade.",
  },
].map((p) => ({ ...p, path: `/preipo/${p.card.company.toLowerCase()}/${p.card.dataset}` }));

// Facilitator: CDP when keys are present (required for Bazaar), else the public x402.org one (local testnet dev only).
const useCdp = Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
const facilitatorConfig = useCdp ? { ...facilitator, timeoutMs: 15_000 } : { url: "https://x402.org/facilitator", timeoutMs: 15_000 };

// Cold starts call getSupported once; a slow facilitator used to hang 90s and return 502.
// Fail fast and retry a few times instead.
class RetryingFacilitatorClient extends HTTPFacilitatorClient {
  async getSupported() {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await super.getSupported();
      } catch (e) {
        lastError = e;
        console.warn(JSON.stringify({ event: "facilitator_supported_retry", attempt, error: String(e?.message || e).slice(0, 160) }));
      }
    }
    throw lastError;
  }
}

const server = new x402ResourceServer(new RetryingFacilitatorClient(facilitatorConfig));
for (const n of NETWORKS) server.register(n, new ExactEvmScheme());
server.registerExtension(bazaarResourceServerExtension);

// One log line per settled sale, so purchases can be attributed to a route (the chain only shows payer and amount).
server.onAfterSettle(async (ctx) => {
  console.log(JSON.stringify({
    event: "sale",
    resource: ctx.paymentPayload?.resource?.url,
    network: ctx.requirements?.network,
    amount: ctx.requirements?.amount,
    payer: ctx.result?.payer,
    tx: ctx.result?.transaction,
    success: ctx.result?.success,
  }));
});

const routes = {};
for (const p of PRODUCTS) {
  const m = p.card.metrics[0];
  routes[`GET ${p.path}`] = {
    accepts: NETWORKS.map((network) => ({ scheme: "exact", price: `$${p.price}`, network, payTo: PAY_TO })),
    description: p.description,
    mimeType: "application/json",
    serviceName: SERVICE_NAME,
    tags: p.tags.slice(0, 5),
    iconUrl: "https://preipo-feed.vercel.app/icon.svg",
    extensions: {
      ...declareDiscoveryExtension({
        output: { example: { company: p.card.company, dataset: p.card.dataset, as_of: p.card.as_of,
          verification: p.card.verification, metrics: [{ id: m.id, value: m.value, label: m.label }], sources: [Object.values(p.card.sources)[0]] } },
      }),
    },
  };
}

const catalog = () => PRODUCTS.map((p) => ({
  path: p.path, company: p.card.company, dataset: p.card.dataset, as_of: p.card.as_of,
  verification: p.card.verification, metric_ids: p.card.metrics.map((m) => m.id), price_usdc: p.price,
}));

const app = express();
app.set("trust proxy", true); // Vercel terminates TLS; use X-Forwarded-Proto so the advertised resource URL is https

// HEAD on a paid route would fall through to the GET handler and return 200 (no body), so HEAD-only checkers
// think the route is free. Answer 402 instead.
const PAID_PATHS = new Set(PRODUCTS.map((p) => p.path));
app.use((req, res, next) => (req.method === "HEAD" && PAID_PATHS.has(req.path) ? res.status(402).end() : next()));

// ---- Discovery files for agents and crawlers ("AI SEO"). All generated from PRODUCTS so they never drift. ----
const SERVICE = {
  name: "PreIPO metrics feed",
  maker: `Built and maintained by ${MAKER.name}, an ${MAKER.role}. Every number is checked against its cited source before it ships, and corrections are logged in each card's changelog.`,
  summary: "Fundamentals of private AI companies (revenue, costs, compute, cash, users, funding) as JSON, priced per call over x402. Every figure carries its own source URL, verification grade and value type.",
  notThis: "Not prices or token quotes, not IPO-filing trackers, not investment advice.",
};
const origin = (req) => `${req.protocol}://${req.get("host")}`;
const howToPay = "GET the endpoint; receive HTTP 402 with a PAYMENT-REQUIRED header; sign and retry with PAYMENT-SIGNATURE (x402 v2, scheme exact). No API key, no account.";

app.get("/.well-known/x402", (req, res) => {
  const o = origin(req);
  res.send({
    x402Version: 2,
    service: SERVICE.name,
    serviceName: SERVICE_NAME,
    maker: { name: MAKER.name, role: MAKER.role, url: MAKER.url },
    iconUrl: `${o}/icon.svg`,
    description: `${SERVICE.summary} ${SERVICE.notThis} ${SERVICE.maker}`,
    docs: `${o}/llms.txt`,
    openapi: `${o}/openapi.json`,
    rails: NETWORKS.map((network) => ({ rail: "x402", version: 2, scheme: "exact", network, asset: "USDC", how: howToPay })),
    payTo: PAY_TO,
    resources: [
      { resource: `${o}/preipo/catalog`, method: "GET", description: "Free catalog: companies, datasets, as_of dates, verification grades, metric ids, prices.", priceUsd: 0, free: true },
      ...PRODUCTS.map((p) => ({
        resource: `${o}${p.path}`, method: "GET", description: p.description, priceUsd: Number(p.price), free: false,
        networks: NETWORKS, tags: p.tags, as_of: p.card.as_of, verification: p.card.verification, metricIds: p.card.metrics.map((m) => m.id),
      })),
    ],
  });
});

app.get("/openapi.json", (req, res) => {
  const o = origin(req);
  const paid = Object.fromEntries(PRODUCTS.map((p) => [p.path, { get: {
    summary: `${p.card.company} ${p.card.dataset}`,
    description: p.description,
    tags: p.tags,
    "x-payment-info": { protocol: "x402", version: 2, scheme: "exact", priceUsd: Number(p.price), asset: "USDC", networks: NETWORKS, payTo: PAY_TO },
    responses: {
      200: { description: "Data card (preipo-card schema).", content: { "application/json": { schema: { $ref: "#/components/schemas/Card" } } } },
      402: { description: "Payment required. Payment terms are in the PAYMENT-REQUIRED header (base64 JSON)." },
    },
  } }]));
  res.send({
    openapi: "3.1.0",
    info: {
      title: SERVICE.name, version: "2.2.0",
      description: `${SERVICE.summary} ${SERVICE.notThis} ${SERVICE.maker}`,
      contact: { name: `${MAKER.name} (${MAKER.role})`, url: MAKER.url },
    },
    servers: [{ url: o }],
    paths: {
      "/preipo/catalog": { get: { summary: "Free catalog", responses: { 200: { description: "List of datasets with as_of, verification and price." } } } },
      ...paid,
    },
    components: { schemas: { Card: {
      type: "object",
      required: ["company", "dataset", "as_of", "metrics", "sources"],
      properties: {
        company: { type: "string" }, dataset: { type: "string" }, as_of: { type: "string", format: "date" },
        verification: { type: "string" },
        metrics: { type: "array", items: { type: "object", required: ["id", "value", "value_type", "verification"], properties: {
          id: { type: "string" }, value: { type: "number" }, label: { type: "string" }, period: { type: "string" }, unit: { type: "string" },
          value_type: { enum: ["approx", "lower_bound", "exact", "derived"] },
          verification: { enum: ["primary", "secondary", "reported", "derived"] },
          source: { type: "string", description: "Key into sources" }, formula: { type: "string" },
        } } },
        sources: { type: "object", additionalProperties: { type: "object", properties: { publisher: { type: "string" }, date: { type: "string" }, url: { type: "string" } } } },
        changelog: { type: "array" },
      },
    } } },
  });
});

app.get("/llms.txt", (req, res) => {
  const o = origin(req);
  res.type("text/plain").send(`# ${SERVICE.name}

> ${SERVICE.summary}

${SERVICE.notThis}

${SERVICE.maker} Contact: ${MAKER.url}

## Why use this instead of reading the news
- One JSON per company, numbers already normalized (USD, fractions, units stated).
- Each metric has its own source URL, a verification grade and a value type, so an agent can decide what to trust without re-reading articles.
- Cards are versioned; a changelog records every correction.

## Endpoints
- [Catalog](${o}/preipo/catalog): free. Companies, datasets, as_of, verification, metric ids, prices.
${PRODUCTS.map((p) => `- [${p.card.company} ${p.card.dataset}](${o}${p.path}): ${p.price} USDC per call. as_of ${p.card.as_of}. ${p.card.metrics.length} metrics.`).join("\n")}

## How to pay
${howToPay}
Networks: ${NETWORKS.join(", ")} (USDC). Pay to ${PAY_TO}.

## Verification grades
- primary: company filing or company statement, checked directly
- secondary: major outlet reporting a company statement or document
- reported: talks or plans per people familiar
- derived: computed by this feed; inherits the weakest grade and value type of its inputs

## Value types
- approx (source says about/nearly), lower_bound (more than/at least), exact (as stated), derived (computed here)

## Machine-readable
- [x402 manifest](${o}/.well-known/x402)
- [OpenAPI](${o}/openapi.json)
- [agents.json](${o}/agents.json)

Factual figures compiled from public reporting. Not investment advice.
`);
});

app.get("/agents.json", (req, res) => {
  const o = origin(req);
  res.send({
    name: SERVICE.name,
    description: SERVICE.summary,
    provider: { name: MAKER.name, role: MAKER.role, url: MAKER.url },
    url: o,
    auth: { type: "x402", networks: NETWORKS, asset: "USDC", payTo: PAY_TO },
    capabilities: PRODUCTS.map((p) => ({
      id: `${p.card.company.toLowerCase()}_${p.card.dataset}`,
      description: p.description,
      method: "GET", url: `${o}${p.path}`, priceUsd: Number(p.price), tags: p.tags,
    })),
    docs: { llms: `${o}/llms.txt`, openapi: `${o}/openapi.json`, x402: `${o}/.well-known/x402` },
  });
});

app.get("/icon.svg", (req, res) =>
  res.type("image/svg+xml").send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#1f2a44"/><text x="32" y="41" font-family="Helvetica,Arial,sans-serif" font-size="22" font-weight="700" fill="#f5c542" text-anchor="middle">IPO</text></svg>`),
);

app.get("/robots.txt", (req, res) =>
  res.type("text/plain").send(`User-agent: *\nAllow: /\n\n# Agents: start at ${origin(req)}/llms.txt or ${origin(req)}/.well-known/x402\n`),
);
app.use(paymentMiddleware(routes, server));

app.get("/", (req, res) =>
  res.send({
    service: "PreIPO metrics feed",
    maker: { name: MAKER.name, role: MAKER.role, url: MAKER.url },
    what: "Fundamentals of private AI companies (revenue, costs, compute, cash, funding) as JSON. Each figure carries as_of, source and a verification grade. Not prices, not advice.",
    pay: { protocol: "x402", asset: "USDC", networks: NETWORKS },
    catalog: "/preipo/catalog",
    discovery: ["/llms.txt", "/.well-known/x402", "/openapi.json", "/agents.json"],
    paid: catalog().map(({ path, price_usdc }) => ({ path, price_usdc })),
  }),
);
app.get("/preipo/catalog", (req, res) => res.send(catalog()));
for (const p of PRODUCTS) app.get(p.path, (req, res) => res.send(p.card));

export default app;
if (!process.env.VERCEL) app.listen(4023, () => console.log("http://localhost:4023/"));

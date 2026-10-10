// PreIPO metrics feed: structured, sourced, verification-graded numbers for private AI companies.
// Paid via x402 (USDC on Base), settled through the CDP facilitator so routes are listed in the x402 Bazaar.
import express from "express";
import { readFileSync } from "node:fs";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { facilitator } from "@coinbase/x402"; // reads CDP_API_KEY_ID / CDP_API_KEY_SECRET
import { RELATED } from "./lib/related.js";
import { onchainVsPrivate } from "./lib/onchain.js";
const OTHERS = RELATED.filter((r) => !r.url.includes("preipo-feed"));

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
  {
    card: load("openai-ipo.json"), price: "0.01", tags: ["openai", "ipo", "pre-ipo", "valuation", "funding", "timeline", "underwriters", "sam-altman", "chatgpt", "ai"],
    description:
      "OpenAI IPO data as JSON: confidential S-1 filing status and announcement date, reported 2027 listing expectations, Sam Altman ruling out a 2026 IPO, latest verified private funding round committed capital and post-money valuation, banks reported working on filing preparation (not confirmed underwriting mandates), and dated timeline. Each factual item has a source reference and verification grade; uncertain dates and unverified figures are omitted.",
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

// Derived route: funding rounds and valuations collected from the verified cards above.
// No new figures: every row keeps its original source, verification grade and value type.
const ROUND = /round|post_money|secondary_sale|tender|stake|total_commitment|valuation_target/;
const fundingRounds = () => ({
  dataset: "ai-lab-funding-rounds",
  generated_at: new Date().toISOString(),
  method: "collected from this feed's company cards; see each row's source",
  companies: [...new Set(PRODUCTS.map((p) => p.card.company))].map((company) => ({
    company,
    rows: PRODUCTS.filter((p) => p.card.company === company).flatMap((p) => p.card.metrics
      .filter((m) => ROUND.test(m.id) && m.value_type !== "derived")
      .map((m) => ({ id: m.id, value: m.value, value_type: m.value_type, unit: m.unit || "USD", period: m.period, label: m.label,
        verification: m.verification, source: p.card.sources[m.source], from_card: p.path }))),
  })),
  publisher: PRODUCTS[0].card.publisher,
  disclaimer: "Factual figures compiled from public reporting, each with source and verification grade. Not investment advice.",
});
const FUNDING_PATH = "/preipo/funding-rounds";
const FUNDING_DESC = "AI lab funding rounds and valuations as JSON (OpenAI, Anthropic): round size, post-money valuation, rounds in talks, employee tender offers, IPO valuation targets, strategic investor commitments. Each row keeps its source URL, verification grade (primary/secondary/reported) and value type.";

// Derived premium route: OpenAI vs Anthropic side by side, built only from the verified cards.
const metric = (company, id) => {
  for (const p of PRODUCTS.filter((x) => x.card.company === company)) {
    const m = p.card.metrics.find((x) => x.id === id);
    if (m) return { value: m.value, value_type: m.value_type, period: m.period, verification: m.verification, label: m.label,
      source: m.source ? p.card.sources[m.source] : undefined, from_card: p.path };
  }
  return null;
};
const ratio = (num, den, note) => (num && den ? { value: Math.round((num.value / den.value) * 10) / 10, unit: "x",
  value_type: "derived", note, inputs: [num, den].map((x) => x.from_card) } : null);
const compareLabs = () => {
  const side = (company, ids) => Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, id ? metric(company, id) : null]));
  const openai = side("OpenAI", { revenue_full_year_2025: "revenue_fy2025", latest_run_rate: "revenue_run_rate_annualized_reported_2026_08",
    last_private_post_money: "last_private_post_money_2026_03", last_private_round_size: "last_private_round_size_2026_03",
    ipo_valuation_target_high: null, compute_obligations: null, cash_and_investments_ye2025: null });
  const anthropic = side("Anthropic", { revenue_full_year_2025: "revenue_fy2025", latest_run_rate: "run_rate_revenue_2026_05",
    last_private_post_money: "last_private_post_money_2026_05", last_private_round_size: "last_private_round_size_2026_05",
    ipo_valuation_target_high: "ipo_valuation_target_high", compute_obligations: "compute_infra_obligations",
    cash_and_investments_ye2025: "cash_equiv_and_st_investments_ye2025" });
  const card = (path) => PRODUCTS.find((p) => p.path === path)?.card;
  return {
    dataset: "openai-vs-anthropic", generated_at: new Date().toISOString(),
    method: "side-by-side view built only from this feed's verified cards; every value keeps its own source, grade and value type",
    openai, anthropic,
    derived: {
      openai_post_money_to_run_rate: ratio(openai.last_private_post_money, openai.latest_run_rate, "run-rate is a lower bound, so the true multiple is at most this"),
      anthropic_post_money_to_run_rate: ratio(anthropic.last_private_post_money, anthropic.latest_run_rate, "run-rate is a lower bound, so the true multiple is at most this"),
    },
    ipo_status: { openai: card("/preipo/openai/ipo")?.ipo_status ?? null, anthropic: card("/preipo/anthropic/ipo")?.ipo_status ?? null },
    gaps: Object.entries({ openai, anthropic }).flatMap(([co, s]) => Object.entries(s).filter(([, v]) => !v).map(([k]) => `${co}.${k}: no verified public figure yet`)),
    caveat: "Companies report revenue and run-rate on their own definitions and dates; compare periods and value types before drawing conclusions.",
    publisher: PRODUCTS[0].card.publisher,
    disclaimer: "Factual figures compiled from public reporting, each with source and verification grade. Not investment advice.",
  };
};
const COMPARE_PATH = "/preipo/compare/openai-anthropic";
const COMPARE_DESC = "OpenAI vs Anthropic side by side as JSON: full-year revenue, latest revenue run-rate, last private round and post-money valuation, IPO status and valuation target, compute obligations, cash, and valuation-to-run-rate multiples. Every value keeps its source URL, verification grade and value type; gaps are listed.";

const ONCHAIN_PATH = "/preipo/onchain-vs-private";
const ONCHAIN_DESC = "On-chain pre-IPO perps vs private valuation, live: OpenAI and Anthropic perpetuals on Hyperliquid HIP-3 (EntropyIO io:OAI, io:ANTH) converted to implied company valuation, set against the last private round post-money and the IPO valuation target. Premium/discount, funding, open interest, 24h volume; each private anchor keeps source and grade.";
const ONCHAIN_TAGS = ["pre-ipo", "hyperliquid", "valuation", "perps", "anthropic"];

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

routes[`GET ${FUNDING_PATH}`] = {
  accepts: NETWORKS.map((network) => ({ scheme: "exact", price: "$0.01", network, payTo: PAY_TO })),
  description: FUNDING_DESC, mimeType: "application/json", serviceName: SERVICE_NAME,
  tags: ["ai-lab", "funding-round", "valuation", "pre-ipo", "openai"], iconUrl: "https://preipo-feed.vercel.app/icon.svg",
  extensions: { ...declareDiscoveryExtension({ output: { example: { dataset: "ai-lab-funding-rounds", companies: [{ company: "Anthropic", rows: [{ id: "last_private_post_money_2026_05", value: 965e9, verification: "primary" }] }] } } }) },
};

routes[`GET ${COMPARE_PATH}`] = {
  accepts: NETWORKS.map((network) => ({ scheme: "exact", price: "$0.05", network, payTo: PAY_TO })),
  description: COMPARE_DESC, mimeType: "application/json", serviceName: SERVICE_NAME,
  tags: ["openai", "anthropic", "comparison", "valuation", "revenue"], iconUrl: "https://preipo-feed.vercel.app/icon.svg",
  extensions: { ...declareDiscoveryExtension({ output: { example: { dataset: "openai-vs-anthropic", derived: { anthropic_post_money_to_run_rate: { value: 20.5, unit: "x" } } } } }) },
};

routes[`GET ${ONCHAIN_PATH}`] = {
  accepts: NETWORKS.map((network) => ({ scheme: "exact", price: "$0.02", network, payTo: PAY_TO })),
  description: ONCHAIN_DESC, mimeType: "application/json", serviceName: SERVICE_NAME,
  tags: ONCHAIN_TAGS, iconUrl: "https://preipo-feed.vercel.app/icon.svg",
  extensions: { ...declareDiscoveryExtension({ output: { example: { dataset: "onchain-preipo-vs-private", companies: [{ company: "Anthropic", asset: "io:ANTH", perp: { implied_valuation_usd: 2.08e12 }, derived: { perp_vs_last_private_pct: 115.6 } }] } } }) },
};

// Free sample: two real metrics per card (with source, grade, value type) and two funding rows, so a buyer can judge before paying.
const sample = () => ({
  note: "Free sample: the first two metrics of each paid card and two funding-round rows, unchanged. Paid endpoints return the full cards.",
  served_at: new Date().toISOString(),
  cards: PRODUCTS.map((p) => ({
    path: p.path, price_usdc: p.price, company: p.card.company, dataset: p.card.dataset, as_of: p.card.as_of,
    metrics_total: p.card.metrics.length,
    metrics: p.card.metrics.slice(0, 2).map((m) => ({ ...m, source: m.source ? p.card.sources[m.source] : undefined })),
  })),
  funding_rounds: { path: FUNDING_PATH, price_usdc: "0.01", rows: fundingRounds().companies.flatMap((c) => c.rows.slice(0, 1).map((r) => ({ company: c.company, ...r }))) },
  publisher: PRODUCTS[0].card.publisher,
});

const catalog = () => PRODUCTS.map((p) => ({
  path: p.path, company: p.card.company, dataset: p.card.dataset, as_of: p.card.as_of,
  verification: p.card.verification, metric_ids: p.card.metrics.map((m) => m.id), price_usdc: p.price,
}));

const app = express();
app.set("trust proxy", true); // Vercel terminates TLS; use X-Forwarded-Proto so the advertised resource URL is https

// HEAD on a paid route would fall through to the GET handler and return 200 (no body), so HEAD-only checkers
// think the route is free. Answer 402 instead.
const PAID_PATHS = new Set([...PRODUCTS.map((p) => p.path), FUNDING_PATH, COMPARE_PATH, ONCHAIN_PATH]);
app.use((req, res, next) => (req.method === "HEAD" && PAID_PATHS.has(req.path) ? res.status(402).end() : next()));

// ---- Discovery files for agents and crawlers ("AI SEO"). All generated from PRODUCTS so they never drift. ----
const SERVICE = {
  name: "PreIPO metrics feed",
  maker: `Built and maintained by ${MAKER.name}, an ${MAKER.role}. Every number is checked against its cited source before it ships, and corrections are logged in each card's changelog.`,
  summary: "Fundamentals of private AI companies (revenue, costs, compute, cash, users, funding) as JSON, priced per call over x402. Every figure carries its own source URL, verification grade and value type.",
  notThis: "Not token quotes or IPO-filing trackers, not investment advice; the only market data is the clearly labelled on-chain pre-IPO perp comparison.",
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
      { resource: `${o}/preipo/sample`, method: "GET", description: "Free sample: two real metrics per card with source, grade and value type, plus funding-round rows.", priceUsd: 0, free: true },
      ...PRODUCTS.map((p) => ({
        resource: `${o}${p.path}`, method: "GET", description: p.description, priceUsd: Number(p.price), free: false,
        networks: NETWORKS, tags: p.tags, as_of: p.card.as_of, verification: p.card.verification, metricIds: p.card.metrics.map((m) => m.id),
      })),
      { resource: `${o}${FUNDING_PATH}`, method: "GET", description: FUNDING_DESC, priceUsd: 0.01, free: false, networks: NETWORKS, tags: ["ai-lab", "funding-round", "valuation", "pre-ipo", "openai"] },
      { resource: `${o}${COMPARE_PATH}`, method: "GET", description: COMPARE_DESC, priceUsd: 0.05, free: false, networks: NETWORKS, tags: ["openai", "anthropic", "comparison", "valuation", "revenue"] },
      { resource: `${o}${ONCHAIN_PATH}`, method: "GET", description: ONCHAIN_DESC, priceUsd: 0.02, free: false, networks: NETWORKS, tags: ONCHAIN_TAGS },
    ],
    related_services: OTHERS,
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
      "/preipo/sample": { get: { summary: "Free sample", responses: { 200: { description: "Two real metrics per card with source, grade and value type." } } } },
      ...paid,
      [ONCHAIN_PATH]: { get: { summary: "On-chain pre-IPO perps vs private valuation", description: ONCHAIN_DESC, tags: ONCHAIN_TAGS,
        "x-payment-info": { protocol: "x402", version: 2, scheme: "exact", priceUsd: 0.02, asset: "USDC", networks: NETWORKS, payTo: PAY_TO },
        responses: { 200: { description: "Live perp-implied valuation vs private anchors." }, 402: { description: "Payment required." } } } },
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
- [Sample](${o}/preipo/sample): free. Two real metrics per card, each with source URL, grade and value type; judge the data before paying.
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

- [AI lab funding rounds](${o}${FUNDING_PATH}): 0.01 USDC. Rounds and valuations collected from the cards above, each row with its source.
- [OpenAI vs Anthropic](${o}${COMPARE_PATH}): 0.05 USDC. Side-by-side revenue, run-rate, valuation, IPO status and multiples; gaps listed.
- [On-chain pre-IPO perps vs private valuation](${o}${ONCHAIN_PATH}): 0.02 USDC. Live Hyperliquid io:OAI / io:ANTH implied valuation vs last private round and IPO target; premium, funding, open interest.

## More from this developer
${OTHERS.map((r) => `- [${r.name}](${r.url}/llms.txt): ${r.what}`).join("\n")}

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
    })).concat([{ id: "ai_lab_funding_rounds", description: FUNDING_DESC, method: "GET", url: `${o}${FUNDING_PATH}`, priceUsd: 0.01 },
      { id: "openai_vs_anthropic", description: COMPARE_DESC, method: "GET", url: `${o}${COMPARE_PATH}`, priceUsd: 0.05 },
      { id: "onchain_preipo_vs_private", description: ONCHAIN_DESC, method: "GET", url: `${o}${ONCHAIN_PATH}`, priceUsd: 0.02 }]),
    docs: { llms: `${o}/llms.txt`, openapi: `${o}/openapi.json`, x402: `${o}/.well-known/x402` },
    related_services: OTHERS,
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
    what: "Fundamentals of private AI companies (revenue, costs, compute, cash, funding) as JSON. Each figure carries as_of, source and a verification grade, plus a live on-chain pre-IPO perp vs private valuation view. Not advice.",
    pay: { protocol: "x402", asset: "USDC", networks: NETWORKS },
    catalog: "/preipo/catalog",
    free: ["/preipo/catalog", "/preipo/sample"],
    discovery: ["/llms.txt", "/.well-known/x402", "/openapi.json", "/agents.json"],
    paid: [...catalog().map(({ path, price_usdc }) => ({ path, price_usdc })), { path: FUNDING_PATH, price_usdc: "0.01" }, { path: COMPARE_PATH, price_usdc: "0.05" }, { path: ONCHAIN_PATH, price_usdc: "0.02" }],
    more_from_this_developer: OTHERS,
  }),
);
app.get("/preipo/catalog", (req, res) => res.send(catalog()));
app.get("/preipo/sample", (req, res) => res.send(sample()));
for (const p of PRODUCTS) app.get(p.path, (req, res) => res.send(p.card));
app.get(FUNDING_PATH, (req, res) => res.send(fundingRounds()));
app.get(COMPARE_PATH, (req, res) => res.send(compareLabs()));
app.get(ONCHAIN_PATH, async (req, res) => {
  try { res.send({ ...(await onchainVsPrivate(metric)), publisher: PRODUCTS[0].card.publisher }); }
  catch (e) { res.status(503).send({ error: "upstream unavailable", detail: String(e.message).slice(0, 160) }); }
});

export default app;
if (!process.env.VERCEL) app.listen(4023, () => console.log("http://localhost:4023/"));

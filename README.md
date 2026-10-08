# PreIPO Feed

[![x402 Bazaar](https://img.shields.io/endpoint?url=https%3A%2F%2Faaron-protocol-radar.vercel.app%2Fbadge%2Fbazaar.json)](https://aaron-protocol-radar.vercel.app/bazaar/standing)

One of four small x402 data services I run alongside my Bitcoin research: [PreIPO Feed](https://preipo-feed.vercel.app/llms.txt) · [Bitcoin Technical Radar](https://btc-radar.vercel.app/llms.txt) · [Protocol Radar](https://aaron-protocol-radar.vercel.app/llms.txt) · [Data MCP](https://aaron-zhang-mcp.vercel.app/llms.txt).

Pay-per-call x402 API (USDC on Base) selling sourced fundamentals of private AI companies.
Live: https://preipo-feed.vercel.app (start at /llms.txt).

- `app.js` — Express server, x402 paywall (CDP facilitator), Bazaar metadata, discovery files.
- `data/*.json` — one data card per route. Every metric needs source + verification + value_type.
- `scripts/validate.mjs` — card validator; runs as the Vercel build step, so a bad card never deploys.

Workflow: change cards on a branch → open a PR → validator runs on the preview deploy → owner merges → production deploys.
Only publicly sourced facts. Never private placement material. Not investment advice.

Deploys: pushing to `main` triggers a Vercel production build (validator first).

Changes to `main` go through pull requests; the validator runs on every preview deploy.

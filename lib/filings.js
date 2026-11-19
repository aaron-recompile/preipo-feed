// Live SEC EDGAR filing tracker for Anthropic, PBC (Nasdaq: ANT, CIK 0002130357).
// Source: data.sec.gov submissions API (primary). Each form type gets a one-line meaning so an agent knows why it matters.
const CIK = "0002130357";
const UA = "preipo-feed-research-bot";
const TTL_MS = 5 * 60_000;
let cache = null;

const MEANING = {
  "S-1": "Registration statement (IPO prospectus, first public version)",
  "S-1/A": "Amendment to the IPO registration statement (updated numbers or terms)",
  "S-1MEF": "Short registration adding shares to an effective S-1 (used when an offering is upsized)",
  "424B4": "Final prospectus with the final IPO price and share count",
  "424B1": "Final prospectus",
  "FWP": "Free writing prospectus (offering material used in marketing)",
  "8-A12B": "Registers the class of shares for listing on an exchange",
  CERT: "Exchange certification that the shares are approved for listing",
  EFFECT: "SEC notice that the registration statement is effective",
  "8-K": "Current report on a material event",
  "10-Q": "Quarterly report",
  "10-K": "Annual report",
  "3": "Initial statement of insider ownership",
  "4": "Change in insider ownership (insider buy or sell)",
  "S-8": "Registers shares for employee equity plans",
  "SC 13G": "Beneficial ownership over 5% (passive holder)",
  "SC 13D": "Beneficial ownership over 5% (active holder)",
  "DRS": "Draft registration statement (confidential, released later)",
  "DRS/A": "Amendment to a draft registration statement",
};

const WATCH = [
  { form: "424B4", why: "final prospectus: confirms price, share count and use of proceeds" },
  { form: "8-K", why: "closing of the offering, underwriter option exercise, material events" },
  { form: "3 / 4", why: "insider holdings and trades once the stock is public" },
  { form: "S-8", why: "employee equity registration, usually soon after listing" },
  { form: "10-Q / 10-K", why: "first public-company quarterly or annual report" },
];

export async function anthropicFilings() {
  if (cache && Date.now() - cache.at < TTL_MS) return { ...cache.data, cache: "hit" };
  try {
    const r = await fetch(`https://data.sec.gov/submissions/CIK${CIK}.json`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`EDGAR HTTP ${r.status}`);
    const d = await r.json();
    const f = d.filings.recent;
    const cikNum = String(Number(CIK));
    const filings = f.form.map((form, i) => {
      const acc = f.accessionNumber[i];
      const folder = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc.replace(/-/g, "")}`;
      return {
        form, filed: f.filingDate[i], accepted_at: f.acceptanceDateTime[i], accession: acc,
        meaning: MEANING[form] || null,
        document_url: f.primaryDocument[i] ? `${folder}/${f.primaryDocument[i]}` : null,
        index_url: `${folder}/${acc}-index.htm`,
      };
    });
    const latestOf = (forms) => filings.find((x) => forms.includes(x.form)) || null;
    const data = {
      dataset: "anthropic-sec-filings", company: d.name, ticker: (d.tickers || [])[0] || "ANT", cik: CIK,
      fetched_at: new Date().toISOString(), source: { publisher: "SEC EDGAR", url: `https://data.sec.gov/submissions/CIK${CIK}.json`, verification: "primary" },
      latest: filings[0] || null,
      milestones: {
        first_public_s1: [...filings].reverse().find((x) => x.form === "S-1") || null,
        latest_s1_amendment: latestOf(["S-1/A"]),
        upsize_registration: latestOf(["S-1MEF"]),
        exchange_listing: latestOf(["8-A12B"]),
        listing_certification: latestOf(["CERT"]),
        final_prospectus: latestOf(["424B4", "424B1"]),
        first_8k: [...filings].reverse().find((x) => x.form === "8-K") || null,
      },
      counts_by_form: filings.reduce((a, x) => ((a[x.form] = (a[x.form] || 0) + 1), a), {}),
      filings: filings.slice(0, 40),
      watch_next: WATCH,
      note: "Pulled live from EDGAR and cached 5 minutes. A null milestone means that filing has not appeared yet.",
      disclaimer: "Factual public-filing data. Not investment advice.",
    };
    cache = { at: Date.now(), data };
    return { ...data, cache: "refreshed" };
  } catch (e) {
    if (cache) return { ...cache.data, cache: "stale_fallback", upstream_error: String(e.message).slice(0, 120) };
    throw e;
  }
}

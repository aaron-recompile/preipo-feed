// Data-card validator. Runs as the Vercel build step: if any card fails, the deploy fails
// and the previous version stays live. Run locally with: node scripts/validate.mjs
import { readFileSync, readdirSync } from "node:fs";

const VALUE_TYPES = new Set(["approx", "lower_bound", "exact", "range_low", "range_high", "derived"]);
const GRADES = new Set(["primary", "secondary", "reported", "derived"]);
// Private placement / deal paperwork must never reach the feed. Generic phrases live here;
// names of specific private counterparties live in scripts/forbidden.local.txt (gitignored, one regex per line)
// and in the optional FORBIDDEN_PATTERNS env var (comma-separated), so the public repo does not reveal them.
const FORBIDDEN = [/capital call/i, /subscription fee/i, /offering memorandum/i, /private placement memorandum/i,
  /beneficial interest/i, /open to top investors/i, /side letter/i, /\bLPA\b/];
try {
  const local = readFileSync(new URL("./forbidden.local.txt", import.meta.url), "utf8");
  for (const line of local.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"))) FORBIDDEN.push(new RegExp(line, "i"));
} catch {}
for (const s of (process.env.FORBIDDEN_PATTERNS || "").split(",").map((x) => x.trim()).filter(Boolean)) FORBIDDEN.push(new RegExp(s, "i"));

const dir = new URL("../data/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const appSrc = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const errors = [];
const err = (f, m) => errors.push(`${f}: ${m}`);

for (const f of files) {
  const raw = readFileSync(new URL(f, dir), "utf8");
  let d;
  try { d = JSON.parse(raw); } catch (e) { err(f, `invalid JSON: ${e.message}`); continue; }

  for (const re of FORBIDDEN) if (re.test(raw)) err(f, `contains forbidden private-source text matching ${re}`);
  for (const k of ["company", "dataset", "as_of", "metrics", "sources", "changelog", "disclaimer", "publisher"])
    if (d[k] === undefined) err(f, `missing top-level field "${k}"`);
  if (!appSrc.includes(`load("${f}")`)) err(f, "not loaded in app.js PRODUCTS (card would never be served)");
  if (!Array.isArray(d.changelog) || d.changelog.length === 0) err(f, "changelog must have at least one entry");

  const sources = d.sources || {};
  for (const [key, s] of Object.entries(sources)) {
    if (!/^https:\/\//.test(s.url || "")) err(f, `source "${key}" needs an https url`);
    if (!s.publisher || !s.date) err(f, `source "${key}" needs publisher and date`);
  }

  const ids = new Set();
  for (const m of d.metrics || []) {
    const at = `metric "${m.id}"`;
    if (!m.id) err(f, "metric without id");
    if (ids.has(m.id)) err(f, `${at} duplicated`);
    ids.add(m.id);
    if (typeof m.value !== "number" || !Number.isFinite(m.value)) err(f, `${at} value must be a finite number`);
    if (!VALUE_TYPES.has(m.value_type)) err(f, `${at} bad value_type "${m.value_type}"`);
    if (!GRADES.has(m.verification)) err(f, `${at} bad verification "${m.verification}"`);
    if (!m.label) err(f, `${at} needs a label`);
    if (m.value_type === "derived" || m.verification === "derived") {
      if (!m.formula) err(f, `${at} is derived but has no formula`);
    } else if (!sources[m.source]) {
      err(f, `${at} source "${m.source}" not found in sources`);
    }
  }
  for (const key of ["underwriters"]) if (d[key] && !sources[d[key].source]) err(f, `${key} source "${d[key].source}" not found`);
  for (const ev of d.timeline || []) if (!sources[ev.source]) err(f, `timeline ${ev.date} source "${ev.source}" not found`);
  for (const ev of d.events || []) if (!sources[ev.source]) err(f, `event ${ev.date} source "${ev.source}" not found`);
}

if (errors.length) {
  console.error(`✗ ${errors.length} problem(s) in data cards:\n` + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}
console.log(`✓ ${files.length} data cards valid`);

// ANT (Anthropic, Nasdaq: ANT) perps across venues vs Nasdaq spot, from the public collector repo
// aaron-recompile/ant-convergence (10 s or faster samples of each venue's public API).
// Policy: this paid route serves a snapshot at least DELAY_MIN minutes old plus the 60 minutes ending there. No live data.
const RAW = "https://raw.githubusercontent.com/aaron-recompile/ant-convergence/main/data";
const DELAY_MIN = 15;
const WINDOW_MIN = 60;
const TTL_MS = 60_000;
const UA = { "User-Agent": "preipo-feed-research-bot" };

const VENUES = {
  binance_ANTUSDT: { venue: "Binance Futures", instrument: "ANTUSDT", quote: "per share, USDT" },
  hl_xyz_ANT: { venue: "Hyperliquid HIP-3 (trade.xyz)", instrument: "xyz:ANT", quote: "per share, USDC" },
  hl_para_ANTH: { venue: "Hyperliquid HIP-3 (para)", instrument: "para:ANTH", quote: "per share, USDC" },
  kraken_PF_ANTXUSD: { venue: "Kraken Futures", instrument: "PF_ANTXUSD", quote: "per share, USD" },
  gate_ANT_USDT: { venue: "Gate.io", instrument: "ANT_USDT", quote: "per share, USDT" },
  bitget_ANTUSDT: { venue: "Bitget", instrument: "ANTUSDT", quote: "per share, USDT" },
  kucoin_ANTUSDTM: { venue: "KuCoin Futures", instrument: "ANTUSDTM", quote: "per share, USDT" },
};

// Funding interval per venue (hours), mirrored from the collector's norm_funding so old rows normalize the same way.
const FUND_HRS = { binance_ANTUSDT: 8, hl_xyz_ANT: 1, hl_para_ANTH: 1, kraken_PF_ANTXUSD: 1, gate_ANT_USDT: 8, bitget_ANTUSDT: 8, kucoin_ANTUSDTM: 8 };
function normFunding(key, v) {
  if (!v || v.funding_apr != null || !(key in FUND_HRS)) return v;
  let raw = v.funding;
  if (key === "binance_ANTUSDT" && v.via === "coingecko" && raw != null) raw = raw / 100;
  if (key === "kraken_PF_ANTXUSD") raw = v.rel_funding ?? (v.funding != null && v.index ? v.funding / v.index : null);
  if (raw == null) return v;
  const f8 = raw * (8 / FUND_HRS[key]);
  return { ...v, funding_8h: f8, funding_apr: f8 * 3 * 365, funding_hrs: FUND_HRS[key] };
}

let cache = null;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const r2 = (x, n = 2) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Fetch the tail of a JSONL file that covers [fromMs, ...]. raw.githubusercontent supports explicit byte ranges only.
async function tail(file, fromMs, maxBytes = 12_000_000) {
  // HEAD reports the gzipped length, so read the true size from a 1-byte range's Content-Range.
  const probe = await fetch(`${RAW}/${file}`, { headers: { ...UA, Range: "bytes=0-0" }, signal: AbortSignal.timeout(6000) });
  if (probe.status !== 206) return [];
  await probe.arrayBuffer();
  const len = Number((probe.headers.get("content-range") || "").split("/")[1] || 0);
  if (!len) return [];
  let span = 400_000, rows = [];
  for (;;) {
    const start = Math.max(0, len - span);
    const r = await fetch(`${RAW}/${file}`, { headers: { ...UA, Range: `bytes=${start}-${len - 1}` }, signal: AbortSignal.timeout(10000) });
    if (!r.ok && r.status !== 206) return [];
    const lines = (await r.text()).split("\n");
    if (start > 0) lines.shift(); // first line is partial
    rows = lines.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (start === 0 || !rows.length || rows[0].ts_epoch * 1000 <= fromMs || span >= maxBytes) return rows;
    span *= 3;
  }
}

async function load(now) {
  const target = now - DELAY_MIN * 60_000, from = target - WINDOW_MIN * 60_000;
  const days = [...new Set([day(from), day(target)])];
  const pull = async (prefix) => (await Promise.all(days.map((d) => tail(`${prefix}_${d}.jsonl`, from)))).flat();
  const [ant, bn] = await Promise.all([pull("ant"), pull("binance")]);
  const inWin = (r) => r.ts_epoch * 1000 >= from && r.ts_epoch * 1000 <= target;
  return { target, from, ant: ant.filter(inWin), bn: bn.filter(inWin) };
}

function venueRow(key, v0, anchors) {
  const v = normFunding(key, v0);
  if (!v) return { key, ...VENUES[key], available: false };
  const mark = v.mark ?? v.last ?? null;
  const bid = v.bid ?? null, ask = v.ask ?? null;
  const mid = bid && ask ? (bid + ask) / 2 : null;
  return {
    key, ...VENUES[key], available: mark != null,
    mark_px: mark, index_px: v.index ?? null, last_px: v.last ?? null, bid, ask,
    spread_bps: mid ? r2(((ask - bid) / mid) * 1e4, 1) : null,
    funding_apr_pct: v.funding_apr != null ? r2(v.funding_apr * 100, 2) : null,
    funding_interval_h: v.funding_hrs ?? null,
    open_interest_contracts: v.oi_contracts ?? null,
    open_interest_usd: v.oi_usd ?? (v.oi_contracts != null && mark ? Math.round(v.oi_contracts * mark) : null),
    volume_24h_usd: v.vol24h_usd ?? v.vol24h_quote ?? null,
    premium_vs_ipo_price_pct: mark && anchors.ipo ? r2((mark / anchors.ipo - 1) * 100) : null,
    premium_vs_nasdaq_pct: mark && anchors.spot ? r2((mark / anchors.spot - 1) * 100) : null,
  };
}

export async function antPerpsVsNasdaq(metric) {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return { ...cache.data, cache: "hit" };
  const { target, from, ant, bn } = await load(now);
  if (!ant.length) throw new Error("no collector samples in the delayed window");
  const snap = ant[ant.length - 1];
  const bsnap = bn.length ? bn[bn.length - 1] : null;
  const rec = { ...snap, binance_ANTUSDT: bsnap?.binance_ANTUSDT ?? snap.binance_ANTUSDT ?? null };
  const spotRec = rec.spot_ANT_nasdaq || {};
  const ipoM = metric("Anthropic", "ipo_price_final");
  const anchors = { ipo: ipoM?.value ?? null, spot: spotRec.price ?? null };
  const venues = Object.keys(VENUES).map((k) => venueRow(k, rec[k], anchors));
  const marks = venues.filter((v) => v.available).map((v) => v.mark_px);
  const med = median(marks);
  for (const v of venues) v.vs_cross_venue_median_bps = v.available && med ? r2((v.mark_px / med - 1) * 1e4, 1) : null;

  // 60-minute window per venue: open/high/low/close of mark and mean funding APR.
  const series = (key, rows) => rows.map((r) => normFunding(key, r[key])).filter((v) => v && (v.mark ?? v.last) != null);
  const win = Object.keys(VENUES).map((k) => {
    const s = series(k, k === "binance_ANTUSDT" && bn.length ? bn : ant);
    if (!s.length) return { key: k, samples: 0 };
    const px = s.map((v) => v.mark ?? v.last);
    const f = s.map((v) => v.funding_apr).filter((x) => x != null);
    return { key: k, samples: s.length, open: px[0], high: Math.max(...px), low: Math.min(...px), close: px[px.length - 1],
      change_pct: r2((px[px.length - 1] / px[0] - 1) * 100), mean_funding_apr_pct: f.length ? r2((f.reduce((a, b) => a + b, 0) / f.length) * 100) : null };
  });
  const spotSeries = ant.map((r) => r.spot_ANT_nasdaq?.price).filter((x) => x != null);

  const data = {
    dataset: "anthropic-perps-vs-nasdaq", ticker: "ANT",
    delay_policy: `Snapshot is at least ${DELAY_MIN} minutes old; window covers the ${WINDOW_MIN} minutes ending at the snapshot. Not a live feed.`,
    snapshot_at: snap.ts_utc, window_start: new Date(from).toISOString(), window_end: new Date(target).toISOString(),
    anchors: {
      ipo_price: ipoM ? { value: ipoM.value, source: "Anthropic pricing press release 2026-11-18", verification: ipoM.verification } : null,
      nasdaq_spot: spotRec.price != null ? { price: spotRec.price, previous_close: spotRec.prev_close ?? null, volume: spotRec.vol ?? null, market_state: spotRec.state ?? null } : { price: null, note: "No Nasdaq print in the window (pre-listing or market closed)." },
    },
    cross_venue: {
      venues_reporting: marks.length, median_mark_px: r2(med, 3), min_mark_px: marks.length ? Math.min(...marks) : null, max_mark_px: marks.length ? Math.max(...marks) : null,
      dispersion_bps: marks.length > 1 ? r2(((Math.max(...marks) - Math.min(...marks)) / med) * 1e4, 1) : null,
      median_premium_vs_ipo_price_pct: med && anchors.ipo ? r2((med / anchors.ipo - 1) * 100) : null,
      median_premium_vs_nasdaq_pct: med && anchors.spot ? r2((med / anchors.spot - 1) * 100) : null,
      median_funding_apr_pct: r2(median(venues.map((v) => v.funding_apr_pct))),
    },
    venues,
    last_60_minutes: { venues: win, nasdaq_spot: spotSeries.length ? { samples: spotSeries.length, open: spotSeries[0], high: Math.max(...spotSeries), low: Math.min(...spotSeries), close: spotSeries[spotSeries.length - 1] } : null },
    binance_positioning: bsnap?.binance_sent ? { long_short_account_ratio: bsnap.binance_sent.ls_account ?? null, top_trader_position_ratio: bsnap.binance_sent.ls_top_pos ?? null, taker_buy_sell_ratio: bsnap.binance_sent.taker_bs ?? null } : null,
    method: "Each venue's public market-data API sampled every 2-10 s by an open-source collector (github.com/aaron-recompile/ant-convergence); funding normalized to an annualized rate across 1 h and 8 h intervals. All quotes are per share, so they compare directly with the IPO price and Nasdaq.",
    sources: [{ publisher: "Venue public APIs via open collector", url: "https://github.com/aaron-recompile/ant-convergence", verification: "primary (exchange APIs)" }],
    caveats: [
      "Perps are cash-settled contracts on the ANT price, not shares; some venues index to pre-listing marks until Nasdaq trades.",
      "A venue missing from the window is reported with available: false rather than filled in.",
    ],
    disclaimer: "Factual market data, delayed. Not investment advice.",
  };
  cache = { at: now, data };
  return { ...data, cache: "refreshed" };
}

// Where ANT can trade right now: Nasdaq session by the US/Eastern clock and holiday list, plus which perp venues reported in the last delayed window.
const HOLIDAYS = { "2026-11-26": "closed (Thanksgiving)", "2026-12-25": "closed (Christmas)", "2027-01-01": "closed (New Year's Day)" };
const EARLY = { "2026-11-27": 13 * 60, "2026-12-24": 13 * 60 };
function etParts(ms) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute), wd: p.weekday, hhmm: `${p.hour}:${p.minute}` };
}
export function nasdaqSession(ms = Date.now()) {
  const t = etParts(ms);
  const close = EARLY[t.date] ?? 16 * 60;
  let session;
  if (t.wd === "Sat" || t.wd === "Sun") session = "closed (weekend)";
  else if (HOLIDAYS[t.date]) session = HOLIDAYS[t.date];
  else if (t.min >= 4 * 60 && t.min < 9 * 60 + 30) session = "pre-market";
  else if (t.min >= 9 * 60 + 30 && t.min < close) session = "regular";
  else if (t.min >= close && t.min < (EARLY[t.date] ? 17 * 60 : 20 * 60)) session = "after-hours";
  else session = "closed (overnight)";
  return { et_date: t.date, et_time: t.hhmm, weekday: t.wd, session, regular_hours_et: `09:30-${EARLY[t.date] ? "13:00 (early close)" : "16:00"}`, extended_hours_et: "04:00-09:30 and close-20:00 (17:00 on early-close days)" };
}

export async function antWhereTrading(metric) {
  const now = Date.now();
  const s = nasdaqSession(now);
  const listed = now >= Date.parse("2026-11-19T14:30:00Z"); // shares cannot trade before the first Nasdaq session
  let perps = null, err = null;
  try {
    const d = await antPerpsVsNasdaq(metric);
    perps = { as_of: d.snapshot_at, delay_minutes_min: DELAY_MIN, venues: d.venues.map((v) => ({ venue: v.venue, instrument: v.instrument, reporting: v.available, hours: "24/7" })) };
  } catch (e) { err = String(e.message).slice(0, 120); }
  return {
    dataset: "anthropic-where-trading", ticker: "ANT", generated_at: new Date(now).toISOString(),
    nasdaq: { listed, ...s, note: "Exchange calendar for 2026-11 to 2027-01; first Nasdaq trade expected 2026-11-19." },
    perpetuals: perps ?? { error: err },
    can_trade_now: {
      nasdaq_shares: !listed ? "no (not listed yet; first trade expected 2026-11-19)" : s.session === "regular" ? "yes (regular session)" : s.session === "pre-market" || s.session === "after-hours" ? `yes, extended hours (${s.session})` : "no",
      perpetuals: perps ? `${perps.venues.filter((v) => v.reporting).length} of ${perps.venues.length} venues reported in the last delayed window` : "unknown",
    },
    not_covered: ["Overnight ATS sessions (for example Blue Ocean) are not tracked yet."],
    disclaimer: "Factual schedule and market-status data. Not investment advice.",
  };
}

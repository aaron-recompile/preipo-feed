// Anthropic (Nasdaq: ANT) preferred stock by series, from the S-1/A Amendment No. 3 (filed 2026-11-17),
// Notes to Consolidated Financial Statements, redeemable convertible preferred stock table "As of September 30, 2026 (unaudited)".
// Share counts in the table are in thousands; carrying value and liquidation preference in USD millions.
// Each preferred share converts into common at the series conversion ratio (10:1, except D-1/D-2/D-3 about 10.6/10.4/10.6),
// so cost per common share = original issue price / conversion ratio. Multiples compare that cost with the IPO price and,
// when Nasdaq has printed, with the latest Nasdaq price from the 15-minute-delayed perps feed.
import { antPerpsVsNasdaq } from "./antmarket.js";

const S1A3 = "https://www.sec.gov/Archives/edgar/data/2130357/000162828026074338/anthropicpbc-sx1ax3.htm";
const TABLE = "S-1/A No. 3, Notes to Consolidated Financial Statements, redeemable convertible preferred stock as of 2026-09-30 (unaudited)";

// [series, round, authorized_k, outstanding_k, original_issue_price, conversion_ratio, carrying_value_musd, liquidation_pref_musd, how_issued]
const ROWS = [
  ["A", "A", 48574, 48574, 2.57, 10, 125, 125, "priced round"],
  ["B", "B", 87430, 87430, 11.23, 10, 982, 982, "priced round (non-voting)"],
  ["C-1", "C", 26397, 26397, 11.23, 10, 296, 296, "priced round"],
  ["C-2", "C", 13362, 13362, 11.23, 10, 150, 150, "priced round (non-voting)"],
  ["D-1", "D", 35013, 35013, 30.0, 10.6, 1042, 1051, "priced round; conversion ratio raised by weighted-average anti-dilution after the Series E-2 issue"],
  ["D-2", "D", 4444, 4444, 27.0, 10.4, 133, 120, "priced round; conversion ratio raised by weighted-average anti-dilution"],
  ["D-3", "D", 4999, 4999, 30.0, 10.6, 146, 150, "priced round (non-voting); conversion ratio raised by weighted-average anti-dilution"],
  ["E-1", "E", 63610, 63610, 56.09, 10, 3549, 3568, "priced round, 2025"],
  ["E-2", "E", 95282, 95282, 20.928, 10, 4728, 1994, "conversion of convertible notes issued under the Amazon 2023 note purchase agreement, Jan-Mar 2025, at $20.9280 per share (about $2.0B)"],
  ["E-3", "E", 12664, 12664, 56.09, 10, 856, 710, "conversion of a convertible note held by one accredited investor, Jan 2025; the S-1 states a purchase price of $44.8692 per share (about $568M) while the table lists an original issue price of $56.09"],
  ["E-4", "E", 15343, 15343, 50.48, 10, 986, 774, "conversion of a convertible note held by one accredited investor, Jan 2025, at $50.4779 per share (about $774M)"],
  ["E-5", "E", 24244, 24244, 53.28, 10, 1598, 1292, "conversion of a convertible note held by one accredited investor, Jan 2025, at $53.2822 per share (about $1.3B)"],
  ["F-1", "F", 92220, 92220, 140.9676, 10, 12999, 13000, "priced round, Aug-Sep 2025, 202 accredited investors, about $13.0B"],
  ["F-2", "F", 20740, 20740, 20.928, 10, 2179, 434, "conversion of convertible notes held by one accredited investor, Aug-Sep 2025, at $20.9280 per share"],
  ["G-1", "G", 90510, 90510, 259.1364, 10, 23454, 23455, "priced round, Q1 2026"],
  ["G-2", "G", 83929, 83929, 259.1364, 10, 33558, 21749, "priced round (non-voting), Q1-Q2 2026"],
  ["G-3", "G", 20563, 20563, 20.928, 10, 4571, 430, "conversion of convertible notes held by one accredited investor, Jan-Feb 2026, at $20.9280 per share (about $430M)"],
  ["G-4", "G", 3322, 3322, 233.2228, 10, 928, 775, "conversion of convertible notes held by one accredited investor, Jan 2026, at $233.2228 per share (about $774M)"],
  ["H-1", "H", 78942, 77638, 589.0095, 10, 45728, 45729, "priced round, Q2 2026 (closed 2026-05-28)"],
  ["H-2", "H", 34808, 33110, 589.0095, 10, 19502, 19502, "priced round (non-voting), Q2 2026"],
  ["H-3", "H", 104472, 0, 20.928, 10, 0, 0, "authorized, none issued as of 2026-09-30"],
  ["H-4", "H", 79573, 0, 50.48, 10, 0, 0, "authorized, none issued as of 2026-09-30"],
];

const r = (x, d = 2) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

export async function anthropicCapTable(metric) {
  const ipo = metric("Anthropic", "ipo_price_final")?.value ?? null;
  const postShares = metric("Anthropic", "shares_outstanding_post_offering_at_final_price")?.value ?? null;
  const newShares = metric("Anthropic", "ipo_shares_offered_by_company_final")?.value ?? null;
  let market = null;
  try {
    const pv = await antPerpsVsNasdaq(metric);
    const p = pv.anchors?.nasdaq_spot?.price;
    if (p != null) market = { price: p, as_of: pv.snapshot_at, market_state: pv.anchors.nasdaq_spot.market_state ?? null, delay: "at least 15 minutes" };
  } catch {}

  const series = ROWS.map(([s, round, auth, out, oip, ratio, carry, liq, how]) => {
    const cost = oip / ratio;
    const commonEq = out * 1000 * ratio;
    return {
      series: s, round, how_issued: how,
      preferred_shares_authorized: auth * 1000, preferred_shares_outstanding: out * 1000,
      original_issue_price_usd: oip, conversion_ratio: ratio,
      cost_per_common_share_usd: r(cost, 4),
      common_shares_on_conversion: r(commonEq, 0),
      pct_of_post_ipo_shares: postShares && out ? r((commonEq / postShares) * 100, 3) : null,
      carrying_value_musd: carry, liquidation_preference_musd: liq,
      multiple_vs_ipo_price: ipo && out ? r(ipo / cost, 2) : null,
      multiple_vs_market: market && out ? r(market.price / cost, 2) : null,
      value_at_ipo_price_usd: ipo && out ? r(commonEq * ipo, 0) : null,
    };
  });

  const issued = series.filter((x) => x.preferred_shares_outstanding > 0);
  const byRound = {};
  for (const x of issued) {
    const b = (byRound[x.round] ||= { round: x.round, series: [], common_shares_on_conversion: 0, invested_usd: 0 });
    b.series.push(x.series);
    b.common_shares_on_conversion += x.common_shares_on_conversion;
    b.invested_usd += x.common_shares_on_conversion * x.cost_per_common_share_usd;
  }
  const rounds = Object.values(byRound).map((b) => {
    const avg = b.invested_usd / b.common_shares_on_conversion;
    return { round: b.round, series: b.series, common_shares_on_conversion: r(b.common_shares_on_conversion, 0),
      weighted_avg_cost_per_common_share_usd: r(avg, 4),
      multiple_vs_ipo_price: ipo ? r(ipo / avg, 2) : null, multiple_vs_market: market ? r(market.price / avg, 2) : null,
      pct_of_post_ipo_shares: postShares ? r((b.common_shares_on_conversion / postShares) * 100, 3) : null };
  });

  const prefCommon = issued.reduce((a, x) => a + x.common_shares_on_conversion, 0);
  const preIpo = postShares && newShares ? postShares - newShares : null;
  return {
    dataset: "anthropic-cap-table", company: "Anthropic", ticker: "ANT", generated_at: new Date().toISOString(),
    source: { document: "SEC Form S-1/A Amendment No. 3, filed 2026-11-17", table: TABLE, url: S1A3, verification: "primary" },
    anchors: {
      ipo_price_usd: ipo, ipo_price_source: "Anthropic pricing press release 2026-11-18",
      market: market ?? { price: null, note: "No Nasdaq print in the delayed window (pre-listing or market closed); multiple_vs_market is null." },
    },
    rounds, series,
    totals: {
      preferred_shares_outstanding: issued.reduce((a, x) => a + x.preferred_shares_outstanding, 0),
      common_shares_on_conversion: r(prefCommon, 0),
      pct_of_post_ipo_shares: postShares ? r((prefCommon / postShares) * 100, 2) : null,
      carrying_value_musd: 157510, liquidation_preference_musd: 136286,
    },
    ipo_dilution: {
      new_shares_sold_by_company: newShares, shares_outstanding_post_offering_approx: postShares,
      shares_outstanding_pre_offering_derived: preIpo,
      dilution_pct_of_post_offering: newShares && postShares ? r((newShares / postShares) * 100, 2) : null,
      note: "Excludes the 147,000,000-share underwriter option until exercised. Post-offering count is derived from the S-1/A and the final pricing release.",
    },
    method: [
      "cost_per_common_share = original issue price / conversion ratio. A 10-for-1 split of common stock took effect on 2026-09-17; preferred converts at 10:1 (Series D at about 10.6/10.4/10.6 after anti-dilution).",
      "multiple = price / cost_per_common_share. It ignores time, fees, dividends (none declared) and lock-ups.",
      "Round rows weight each series by common shares on conversion, so note conversions at low prices pull a round's average cost down.",
    ],
    caveats: [
      "The four $20.928 series (E-2, F-2, G-3, and the unissued H-3) are convertible-note conversions, not cash rounds; the S-1 names the Amazon 2023 note purchase agreement for E-2 and describes the holder of F-2 and G-3 only as one accredited investor.",
      "E-3: the table's original issue price ($56.09) differs from the conversion purchase price stated in the S-1 ($44.8692); this feed uses the table value.",
      "Holdings at 2026-09-30; transfers and secondary sales after that date are not reflected.",
    ],
  };
}

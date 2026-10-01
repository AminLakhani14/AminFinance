/**
 * IMF SDMX 2.1 — the monthly half of the economy tab.
 *
 * The World Bank only publishes calendar-year aggregates, which meant the tab
 * showed a CPI figure that was up to 20 months old. The IMF republishes the
 * same national statistics at monthly frequency, keyless, and Pakistan's
 * authority (NSAPK) reports into it — CPI inflation is current to last month,
 * trade to about four months back.
 *
 * ⚠️ Host matters. `dataservices.imf.org` (the old SDMX host) no longer
 * resolves, `www.imf.org/external/datamapper` is Akamai-blocked to non-browser
 * clients, and `sdmxcentral.imf.org` answers metadata but returns HTTP 501
 * "Data Queries are not implemented". Only `api.imf.org/external/sdmx/2.1`
 * serves data. Do not "fix" this by switching hosts without re-testing.
 *
 * Two traps encoded below, both of which silently return an empty dataset —
 * HTTP 200 with no <Obs> — rather than an error:
 *   • The country code is ISO-3 (`PAK`), not ISO-2 (`PK`).
 *   • The key is positional and must have exactly one slot per dimension.
 *     Too many dots is a 400; too few is an empty result.
 *
 * Responses are XML regardless of the Accept header (a JSON request is
 * answered with XML), so this parses the flat StructureSpecificData form with
 * a regex over `<Obs .../>` attributes rather than pulling in an XML library
 * for what is a fixed, attribute-only shape.
 */
import { httpGetText } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { acquire } from '../lib/rateLimit.js';

const PROVIDER = 'IMF';
const BASE = 'https://api.imf.org/external/sdmx/2.1/data';

/** ISO-3. `PK` returns an empty dataset, not an error — see the header note. */
const COUNTRY = 'PAK';

export interface ImfObservation {
  /** `2026-M08` as published. */
  period: string;
  value: number;
}

/**
 * One monthly series.
 *
 * `dataflow` carries the agency, id and version together because the API
 * requires all three (`IMF.STA,CPI,5.0.0`); a bare id resolves to a different,
 * often empty, default version.
 */
export interface ImfSeries {
  dataflow: string;
  /**
   * The dimension values after the country, in declaration order. The country
   * is prepended and `M` (monthly) appended, so this holds only the middle.
   */
  key: string[];
  /**
   * Power of ten the observations are expressed in. The response carries a
   * `SCALE` attribute, but it is advisory and has been seen to disagree with
   * the values, so the caller states the scale it expects.
   */
  scale: number;
}

/** `2026-M08` → epoch ms at the end of that month, for sorting and display. */
export function periodToDate(period: string): number {
  const match = /^(\d{4})-M(\d{1,2})$/.exec(period);
  if (!match) return Date.now();
  const year = Number(match[1]);
  const month = Number(match[2]);
  // Day 0 of the next month is the last day of this one, which is the right
  // instant for "the August figure" — the month has completed.
  return Date.UTC(year, month, 0);
}

/** `2026-M08` → `Aug 2026`. */
export function periodLabel(period: string): string {
  const match = /^(\d{4})-M(\d{1,2})$/.exec(period);
  if (!match) return period;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)).toLocaleDateString(
    'en-GB',
    { month: 'short', year: 'numeric', timeZone: 'UTC' },
  );
}

/**
 * Observations for one monthly series, oldest first.
 *
 * Throws `notFound` on an empty dataset rather than returning `[]`: an empty
 * result here always means the key was wrong or the country does not report
 * the series, and both should surface as a failed indicator the caller can
 * report, not as a tile rendering zero points.
 */
export async function getMonthlySeries(
  series: ImfSeries,
  startPeriod: string,
): Promise<ImfObservation[]> {
  try {
    await acquire('imf');
  } catch {
    throw AppError.rateLimited(PROVIDER, 30);
  }

  const key = [COUNTRY, ...series.key, 'M'].join('.');
  const url = `${BASE}/${series.dataflow}/${key}?startPeriod=${startPeriod}`;

  const xml = await httpGetText(url, { provider: PROVIDER, timeoutMs: 20_000 });

  const observations: ImfObservation[] = [];
  // Attribute order within <Obs> is stable in practice but not guaranteed, so
  // each attribute is matched independently inside the tag rather than as one
  // fixed sequence.
  const obsPattern = /<Obs\s([^>]*?)\/>/g;
  for (const match of xml.matchAll(obsPattern)) {
    const attributes = match[1] ?? '';
    const period = /TIME_PERIOD="([^"]+)"/.exec(attributes)?.[1];
    const rawValue = /OBS_VALUE="([^"]+)"/.exec(attributes)?.[1];
    if (!period || rawValue === undefined) continue;

    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;

    observations.push({ period, value: value * 10 ** series.scale });
  }

  if (observations.length === 0) {
    throw AppError.notFound(
      `IMF returned no observations for ${series.dataflow} (${key}).`,
    );
  }

  return observations.sort((a, b) => periodToDate(a.period) - periodToDate(b.period));
}

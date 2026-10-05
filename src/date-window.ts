/**
 * Relative-date parsing for the deterministic discovery fallback.
 *
 * "noget for børn på søndag i Aarhus" names a day but the fallback only knew
 * city + category, so the date was ignored (or, worse, the message was not even
 * recognised as a discovery question). This turns Danish weekday names and
 * "i dag / i morgen / i aften" into an instant window anchored in
 * Europe/Copenhagen, which is what the reader means by "søndag".
 *
 * Pure: `now` is a parameter so tests can pin it.
 */

export const LOCAL_TZ = "Europe/Copenhagen";

export type DateWindow = {
  /** Inclusive lower bound, ISO instant with Z. */
  from: string;
  /** Exclusive upper bound, ISO instant with Z. */
  to: string;
  /** What the reader said, for honest "I loosened X" copy. */
  label: string;
};

type Ymd = { y: number; m: number; d: number };

const WEEKDAYS: Array<{ re: RegExp; dow: number; label: string }> = [
  { re: /(?<!\p{L})s[øo]ndag\p{L}*/iu, dow: 0, label: "søndag" },
  { re: /(?<!\p{L})mandag\p{L}*/iu, dow: 1, label: "mandag" },
  { re: /(?<!\p{L})tirsdag\p{L}*/iu, dow: 2, label: "tirsdag" },
  { re: /(?<!\p{L})onsdag\p{L}*/iu, dow: 3, label: "onsdag" },
  { re: /(?<!\p{L})torsdag\p{L}*/iu, dow: 4, label: "torsdag" },
  { re: /(?<!\p{L})fredag\p{L}*/iu, dow: 5, label: "fredag" },
  { re: /(?<!\p{L})l[øo]rdag\p{L}*/iu, dow: 6, label: "lørdag" },
];

/** Offset (ms, local minus UTC) of LOCAL_TZ at the given instant. */
function tzOffsetMs(instant: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LOCAL_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant at which the Copenhagen wall clock reads y-m-d hh:00. */
export function localInstant({ y, m, d }: Ymd, hour = 0): number {
  const naive = Date.UTC(y, m - 1, d, hour);
  let guess = naive - tzOffsetMs(naive);
  guess = naive - tzOffsetMs(guess); // second pass settles dates next to a DST switch
  return guess;
}

/** Calendar day in Copenhagen for an instant. */
export function localYmd(now: Date): Ymd & { dow: number } {
  const local = new Date(now.getTime() + tzOffsetMs(now.getTime()));
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate(), dow: local.getUTCDay() };
}

export function addDays({ y, m, d }: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function dayWindow(day: Ymd, label: string): DateWindow {
  return {
    from: new Date(localInstant(day)).toISOString(),
    to: new Date(localInstant(addDays(day, 1))).toISOString(),
    label,
  };
}

/** Null when the message names no resolvable date. */
export function resolveDateWindow(message: string, now: Date = new Date()): DateWindow | null {
  const text = String(message || "");
  const today = localYmd(now);

  if (/(?<!\p{L})i\s?aften(?!\p{L})/iu.test(text)) {
    return {
      from: new Date(localInstant(today, 17)).toISOString(),
      to: new Date(localInstant(addDays(today, 1))).toISOString(),
      label: "i aften",
    };
  }
  if (/(?<!\p{L})i\s?morgen(?!\p{L})/iu.test(text)) return dayWindow(addDays(today, 1), "i morgen");
  if (/(?<!\p{L})i\s?dag(?!\p{L})/iu.test(text)) return dayWindow(today, "i dag");

  for (const wd of WEEKDAYS) {
    if (wd.re.test(text)) return dayWindow(addDays(today, (wd.dow - today.dow + 7) % 7), wd.label);
  }
  return null;
}

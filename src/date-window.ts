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
  { re: /(?<!\p{L})(?:s[øo]ndag\p{L}*|sunday)/iu, dow: 0, label: "søndag" },
  { re: /(?<!\p{L})(?:mandag\p{L}*|monday)/iu, dow: 1, label: "mandag" },
  { re: /(?<!\p{L})(?:tirsdag\p{L}*|tuesday)/iu, dow: 2, label: "tirsdag" },
  { re: /(?<!\p{L})(?:onsdag\p{L}*|wednesday)/iu, dow: 3, label: "onsdag" },
  { re: /(?<!\p{L})(?:torsdag\p{L}*|thursday)/iu, dow: 4, label: "torsdag" },
  { re: /(?<!\p{L})(?:fredag\p{L}*|friday)/iu, dow: 5, label: "fredag" },
  { re: /(?<!\p{L})(?:l[øo]rdag\p{L}*|saturday)/iu, dow: 6, label: "lørdag" },
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

  if (/(?<!\p{L})(?:i\s?aften|tonight|this evening)(?!\p{L})/iu.test(text)) {
    return {
      from: new Date(localInstant(today, 17)).toISOString(),
      to: new Date(localInstant(addDays(today, 1))).toISOString(),
      label: "i aften",
    };
  }
  if (/(?<!\p{L})(?:i\s?morgen|tomorrow)(?!\p{L})/iu.test(text)) return dayWindow(addDays(today, 1), "i morgen");
  if (/(?<!\p{L})(?:i\s?dag|today)(?!\p{L})/iu.test(text)) return dayWindow(today, "i dag");
  if (/(?<!\p{L})(?:(?:i\s)?denne\s+uge|i\s+ugen|this\s+week)(?!\p{L})/iu.test(text)) {
    // Now -> next Monday 00:00 local.
    return {
      from: now.toISOString(),
      to: new Date(localInstant(addDays(today, ((8 - today.dow) % 7) || 7))).toISOString(),
      label: "denne uge",
    };
  }

  // Explicit day: "15. oktober", "den 15 okt", "15/10", "october 15", "15 october".
  const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, maj: 5, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dec: 12 };
  const mName = "(jan|feb|mar|apr|maj|may|jun|jul|aug|sep|okt|oct|nov|dec)\\p{L}*";
  let dm: RegExpMatchArray | null = null; let day = 0; let month = 0;
  if ((dm = text.match(new RegExp(`(?<!\\d)(\\d{1,2})\\.?\\s*${mName}`, "iu")))) { day = +dm[1]; month = MONTHS[dm[2].toLowerCase()]; }
  else if ((dm = text.match(new RegExp(`${mName}\\s+(\\d{1,2})(?!\\d)`, "iu")))) { day = +dm[2]; month = MONTHS[dm[1].toLowerCase()]; }
  else if ((dm = text.match(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/))) { day = +dm[1]; month = +dm[2]; }
  if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
    const y = month < today.m || (month === today.m && day < today.d) ? today.y + 1 : today.y;
    return dayWindow({ y, m: month, d: day }, `${day}. ${["januar","februar","marts","april","maj","juni","juli","august","september","oktober","november","december"][month - 1]}`);
  }

  for (const wd of WEEKDAYS) {
    if (wd.re.test(text)) return dayWindow(addDays(today, (wd.dow - today.dow + 7) % 7), wd.label);
  }
  if (/(?<!\p{L})weekend\p{L}*/iu.test(text)) {
    // Fri 17:00 -> Sun 23:59 local (exclusive end: Mon 00:00). From Monday
    // 00:00 on, the weekend that just ended is over, so it means the next one.
    const friday = addDays(today, today.dow === 0 ? -2 : today.dow === 6 ? -1 : 5 - today.dow);
    return {
      from: new Date(localInstant(friday, 17)).toISOString(),
      to: new Date(localInstant(addDays(friday, 3))).toISOString(),
      label: "i weekenden",
    };
  }
  return null;
}

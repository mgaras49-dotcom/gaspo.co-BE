/**
 * The date and time as the person asking would read it, e.g.
 * "Monday, 5 October 2026 at 19:42 (Australia/Sydney)". The model has no clock of
 * its own, and without this it answered "what time is it?" with "I don't have
 * access to a clock" and could not resolve "today" or "last week".
 *
 * An unknown or missing zone falls back to UTC rather than failing the run.
 */
export function describeNow(now: Date, timeZone: string | null | undefined): string {
  for (const zone of [timeZone, 'UTC']) {
    if (!zone) continue;
    try {
      const text = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(now);
      return `${text} (${zone})`;
    } catch {
      // RangeError for a zone Intl does not know; try the next one.
    }
  }
  return now.toISOString();
}

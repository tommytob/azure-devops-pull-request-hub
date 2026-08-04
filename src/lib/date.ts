export function compare(a: Date, b: Date): number {
  return a.getTime() - b.getTime();
}

/**
 * The most recent of the given dates, or undefined when there are none.
 *
 * Exists because reduce without an initial value throws on an empty array, and
 * a pull request with no comment threads produces exactly that.
 */
export function mostRecent(dates: Date[]): Date | undefined {
  return dates.reduce<Date | undefined>(
    (latest, date) =>
      latest === undefined || compare(date, latest) > 0 ? date : latest,
    undefined
  );
}

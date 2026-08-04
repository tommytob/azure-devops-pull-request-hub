import { compare, mostRecent } from "./date";

describe("mostRecent", () => {
  // The case that threw: reduce without an initial value on an empty array.
  it("returns undefined for no dates at all", () => {
    expect(mostRecent([])).toBeUndefined();
  });

  it("returns the only date when there is one", () => {
    const only = new Date("2026-08-04T10:00:00Z");

    expect(mostRecent([only])).toBe(only);
  });

  it("returns the latest date regardless of the order given", () => {
    const older = new Date("2026-08-01T10:00:00Z");
    const newer = new Date("2026-08-04T10:00:00Z");

    expect(mostRecent([older, newer])).toBe(newer);
    expect(mostRecent([newer, older])).toBe(newer);
  });

  it("keeps the first of two equal dates", () => {
    const first = new Date("2026-08-04T10:00:00Z");
    const second = new Date("2026-08-04T10:00:00Z");

    expect(mostRecent([first, second])).toBe(first);
  });
});

describe("compare", () => {
  it("is positive when the first date is later", () => {
    expect(
      compare(new Date("2026-08-04"), new Date("2026-08-01"))
    ).toBeGreaterThan(0);
  });

  it("is zero for the same moment", () => {
    expect(compare(new Date("2026-08-04"), new Date("2026-08-04"))).toBe(0);
  });
});

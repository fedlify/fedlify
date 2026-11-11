import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime } from "@/lib/format";

describe("date format", () => {
  const morning = new Date(2026, 10, 5, 11, 3);
  const afternoon = new Date(2026, 0, 9, 15, 30);

  it("formats a date as 'Nov 5, 2026'", () => {
    expect(formatDate(morning)).toBe("Nov 5, 2026");
    expect(formatDate(morning.toISOString())).toBe(formatDate(morning));
  });

  it("formats a date and time as 'Nov 5, 2026, 11:03 AM'", () => {
    expect(formatDateTime(morning)).toBe("Nov 5, 2026, 11:03 AM");
    expect(formatDateTime(afternoon)).toBe("Jan 9, 2026, 3:30 PM");
  });

  it("returns the fallback for empty or invalid values", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate(undefined, "-")).toBe("-");
    expect(formatDate("not a date", "Not recorded")).toBe("Not recorded");
    expect(formatDateTime("", "-")).toBe("-");
  });
});

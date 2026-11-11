/** One date format for the whole app: "Nov 5, 2026" and "Nov 5, 2026, 11:03 AM" (in the viewer's time zone). */

type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Newer ICU versions put a narrow no-break space before AM/PM; a plain space reads and tests the same everywhere.
const plain = (text: string) => text.replace(/\s/g, " ");

export function formatDate(value: DateInput, fallback = ""): string {
  const date = toDate(value);
  if (!date) return fallback;
  return plain(new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date));
}

export function formatDateTime(value: DateInput, fallback = ""): string {
  const date = toDate(value);
  if (!date) return fallback;
  return plain(
    new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date)
  );
}

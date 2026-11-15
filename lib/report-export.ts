const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const DATE_COLUMN_KEYS = new Set(["dateKey", "createdAt", "updatedAt", "sentAt"]);

export function neutralizeSpreadsheetText(value: string): string {
  return FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

export function csvCell(value: string | number | boolean | null): string {
  if (value == null) return "";
  const text = typeof value === "string" ? neutralizeSpreadsheetText(value) : String(value);
  return text.includes(",") || text.includes('"') || text.includes("\n") || text.includes("\r")
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

export function xlsxCellValue(value: string | number | boolean | Date | null, key: string): string | number | boolean | Date | null {
  if (value == null || typeof value === "number" || typeof value === "boolean" || value instanceof Date) return value;
  if (typeof value === "string" && DATE_COLUMN_KEYS.has(key) && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return neutralizeSpreadsheetText(String(value));
}

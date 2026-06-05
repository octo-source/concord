// XLSX ingestion via SheetJS. Every sheet contributes rows tagged with a
// __sheet column; Date cells become ISO strings.
import { readFile } from "node:fs/promises";
import XLSX from "xlsx";
import { ConcordError } from "../core/errors.js";

function toIso(d) {
  // Render as date-only when the time component is exactly midnight UTC.
  const iso = d.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

export async function parse(filePath) {
  let buf;
  try {
    buf = await readFile(filePath);
  } catch (e) {
    throw new ConcordError("FILE_READ", `cannot read ${filePath}: ${e.message}`, { filePath });
  }
  let wb;
  try {
    wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  } catch (e) {
    throw new ConcordError("BAD_XLSX", `cannot parse workbook: ${e.message}`, { filePath });
  }
  const issues = [];
  const rows = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const sheetRows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: true });
    if (sheetRows.length === 0) {
      issues.push({ kind: "empty_sheet", detail: `sheet "${sheetName}" has no data rows` });
      continue;
    }
    for (const r of sheetRows) {
      const row = { __sheet: sheetName };
      for (const [k, v] of Object.entries(r)) {
        row[k] = v instanceof Date ? toIso(v) : v;
      }
      rows.push(row);
    }
  }
  if (rows.length === 0) issues.push({ kind: "empty", detail: "workbook contains no data rows" });
  return { rows, issues };
}

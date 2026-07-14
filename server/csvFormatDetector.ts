/**
 * AI-powered CSV format detector for PocketPulse.
 *
 * When the heuristic parser in csvParser.ts cannot identify the column layout
 * of a bank's CSV export, this module sends the header row + a handful of
 * ANONYMIZED sample data rows to the configured OpenAI model and asks it to identify the
 * column roles.
 *
 * Privacy: only column headers and type-classified sample values are sent.
 * Description/merchant cells are replaced with "[text]"; amount signs are
 * preserved but values are rounded; dates are sent verbatim (needed to detect
 * the date format). No bulk transaction data leaves the server.
 *
 * The returned spec is cached in `csv_format_specs` so repeat uploads from
 * the same bank format never incur a second AI call.
 *
 * Returns null on any failure so callers can fall back gracefully.
 */
import OpenAI from "openai";
import type { CsvFormatSpec } from "../shared/schema.js";

let _client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

const CSV_FORMAT_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "pocketpulse_csv_format_spec",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        preambleRows: { type: "number" },
        hasHeader: { type: "boolean" },
        dateColumn: { type: "number" },
        descriptionColumn: { type: "number" },
        amountColumn: { type: ["number", "null"] },
        debitColumn: { type: ["number", "null"] },
        creditColumn: { type: ["number", "null"] },
        typeColumn: { type: ["number", "null"] },
        signConvention: { type: "string", enum: ["signed", "unsigned"] },
        dateFormat: { type: ["string", "null"] },
      },
      required: [
        "preambleRows",
        "hasHeader",
        "dateColumn",
        "descriptionColumn",
        "amountColumn",
        "debitColumn",
        "creditColumn",
        "typeColumn",
        "signConvention",
        "dateFormat",
      ],
    },
  },
} as const;

const SYSTEM_PROMPT = `You are a CSV format analyzer for a financial transaction parser.

Given the first few rows of a bank CSV export (with text/merchant content already masked),
identify the column structure and date format.

Return ONLY a JSON object with this exact shape (no extra keys):
{
  "preambleRows": <number of rows before the header row; 0 if header is first>,
  "hasHeader": <true if there is a named header row, false for headerless/positional formats>,
  "dateColumn": <0-based column index of the transaction date>,
  "descriptionColumn": <0-based column index of the merchant/description>,
  "amountColumn": <0-based column index of a combined amount column, or null>,
  "debitColumn": <0-based column index of a debit/withdrawal column, or null>,
  "creditColumn": <0-based column index of a credit/deposit column, or null>,
  "typeColumn": <0-based column index of a transaction-type/DR-CR column, or null>,
  "signConvention": <"signed" if negative=outflow, "unsigned" if all amounts are positive>,
  "dateFormat": <format string like "MM/DD/YYYY", "YYYY-MM-DD", "MMM D YYYY", "D MMM YYYY", "MMM D, YYYY"; or null if standard format>
}

Rules:
- amountColumn and debit/creditColumn are mutually exclusive. If the bank uses
  separate Debit and Credit columns, set amountColumn=null.
- If the bank uses a single Amount column, set amountColumn to its index and set
  debitColumn=null, creditColumn=null.
- signConvention="signed" when negative numbers indicate outflows.
- signConvention="unsigned" when all amounts appear positive.
- preambleRows is the count of rows before the header row (0 when header is row 0).
  For headerless files, preambleRows=0 and hasHeader=false.
- dateFormat: use standard tokens YYYY, MM, DD, MMM (3-letter month), MMMM (full month).
  Set to null only when the date is in a standard format already handled (MM/DD/YYYY,
  YYYY-MM-DD, MM-DD-YYYY, MM/DD/YY) — because those don't need special handling.
  For all other formats (month names, ordinals, non-US ordering), provide the token string.
- Return only valid JSON with no markdown fences, no commentary.`;

/**
 * GPT-5 reasoning tokens count against the completion ceiling. Keep reasoning
 * minimal while leaving enough headroom for a complete structured format spec.
 */
export function _csvFormatGenerationOptions(model: string) {
  return model.startsWith("gpt-5")
    ? {
        reasoning_effort: "minimal" as const,
        max_completion_tokens: 4000,
      }
    : {
        temperature: 0 as const,
        max_tokens: 350,
      };
}

/**
 * Determine if a cell value looks like a date.
 * Used to decide whether to send the value verbatim (needed for date format detection).
 */
function looksLikeDate(cell: string): boolean {
  const t = cell.trim();
  if (!t) return false;
  return (
    /^\d{1,4}[\/\-]\d{1,2}([\/\-]\d{2,4})?$/.test(t) ||
    /^[A-Za-z]+(\.|\s)\s*\d{1,2}(st|nd|rd|th)?,?\s*\d{4}$/i.test(t) ||
    /^\d{1,2}\s+[A-Za-z]+\s+\d{4}$/i.test(t) ||
    /^\d{4}[\/\-]\d{2}[\/\-]\d{2}$/.test(t)
  );
}

/**
 * Determine if a cell value looks like an amount.
 * Amount cells are sent verbatim so the AI can detect sign convention.
 */
function looksLikeAmount(cell: string): boolean {
  const t = cell.trim();
  if (!t) return false;
  return /^-?\$?[\d,]+\.?\d*$/.test(t) || /^\([0-9,]+\.?\d*\)$/.test(t);
}

/**
 * Mask a single cell for the AI payload:
 * - Date-like values → sent verbatim (needed for format detection)
 * - Amount-like values → sent verbatim, but truncated to 2dp (sign matters)
 * - Empty cells → sent as empty string
 * - Everything else (descriptions, names, merchants) → masked as "[text]"
 */
function maskCell(cell: string): string {
  const t = cell.trim();
  if (!t) return '""';
  if (looksLikeDate(t)) return JSON.stringify(t);
  if (looksLikeAmount(t)) {
    // Keep sign and general magnitude but round to avoid precision leakage
    const num = parseFloat(t.replace(/[^0-9.\-]/g, ""));
    if (!isNaN(num)) return JSON.stringify(num.toFixed(2));
    return JSON.stringify(t);
  }
  // Mask text content — the AI only needs to know "this is a text column"
  return '"[text]"';
}

/**
 * Find the index of the true header row: the first row where ALL non-empty
 * cells are text-like (no dates, no amounts). Only this single row is sent
 * verbatim to the AI — all other rows (preamble and data) are masked.
 * Returns -1 when no header row is found (headerless format).
 */
function findHeaderRowIndex(rawRows: string[][]): number {
  for (let i = 0; i < rawRows.length && i < 10; i++) {
    const row = rawRows[i];
    const nonEmpty = row.filter((c) => c.trim());
    if (nonEmpty.length < 2) continue;
    if (
      nonEmpty.every(
        (c) => !looksLikeDate(c.trim()) && !looksLikeAmount(c.trim()),
      )
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Build a privacy-safe, compact representation of sample rows for the AI.
 *
 * Privacy rules (strict):
 * - Only the single detected header row is sent verbatim (column names are not PII).
 * - ALL other rows — including bank preamble rows that may contain account holder
 *   names, addresses, or statement metadata — have every text cell masked as "[text]".
 * - Date-like cells in data rows are sent verbatim (needed for format detection).
 * - Amount-like cells in data rows are sent rounded (sign needed for convention detection).
 */
function buildMaskedSampleText(rawRows: string[][]): string {
  const headerIdx = findHeaderRowIndex(rawRows);

  return rawRows
    .map((row, i) => {
      const cells =
        i === headerIdx
          ? row.map((c) => JSON.stringify(c)) // header row only — verbatim
          : row.map(maskCell); // preamble + data rows — mask text

      return `[row ${i}]: ${cells.join(", ")}`;
    })
    .join("\n");
}

type RawSpec = {
  preambleRows: unknown;
  hasHeader: unknown;
  dateColumn: unknown;
  descriptionColumn: unknown;
  amountColumn: unknown;
  debitColumn: unknown;
  creditColumn: unknown;
  typeColumn: unknown;
  signConvention: unknown;
  dateFormat: unknown;
};

function isNullableNumber(v: unknown): v is number | null {
  return v === null || typeof v === "number";
}

function isValidSpec(raw: RawSpec): raw is {
  preambleRows: number;
  hasHeader: boolean;
  dateColumn: number;
  descriptionColumn: number;
  amountColumn: number | null;
  debitColumn: number | null;
  creditColumn: number | null;
  typeColumn: number | null;
  signConvention: "signed" | "unsigned";
  dateFormat: string | null;
} {
  if (typeof raw.preambleRows !== "number" || raw.preambleRows < 0)
    return false;
  if (typeof raw.hasHeader !== "boolean") return false;
  if (typeof raw.dateColumn !== "number" || raw.dateColumn < 0) return false;
  if (typeof raw.descriptionColumn !== "number" || raw.descriptionColumn < 0)
    return false;
  if (!isNullableNumber(raw.amountColumn)) return false;
  if (!isNullableNumber(raw.debitColumn)) return false;
  if (!isNullableNumber(raw.creditColumn)) return false;
  if (!isNullableNumber(raw.typeColumn)) return false;
  if (raw.signConvention !== "signed" && raw.signConvention !== "unsigned")
    return false;
  if (raw.dateFormat !== null && typeof raw.dateFormat !== "string")
    return false;
  // Must have at least one amount-related column
  if (
    raw.amountColumn === null &&
    raw.debitColumn === null &&
    raw.creditColumn === null
  )
    return false;
  return true;
}

/**
 * Ask the configured OpenAI model to identify the column layout of a CSV.
 *
 * @param allRows  The first N raw parsed rows (header + preamble + a few data rows),
 *                 already split into cells by csv-parse. Max 12 rows.
 * @returns        A validated CsvFormatSpec, or null on failure.
 */
export async function detectCsvFormat(
  allRows: string[][],
): Promise<CsvFormatSpec | null> {
  const client = getClient();
  if (!client) return null;
  if (allRows.length === 0) return null;

  const MAX_SAMPLE_ROWS = 8; // header/preamble rows + at most 4-5 data rows
  const sampleRows = allRows.slice(0, MAX_SAMPLE_ROWS);
  const sampleText = buildMaskedSampleText(sampleRows);

  let raw: string | null = null;
  try {
    const model = process.env.OPENAI_CSV_FORMAT_MODEL ?? "gpt-5-nano";
    const request = {
      model,
      response_format: CSV_FORMAT_RESPONSE_FORMAT,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Identify the column layout and date format from these CSV rows:\n\n${sampleText}`,
        },
      ],
      ..._csvFormatGenerationOptions(model),
    } as const;

    const response = await client.chat.completions.create(request as any);
    raw = response.choices[0]?.message?.content ?? null;
  } catch (err) {
    console.warn(
      `[csvFormatDetector] OpenAI call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(
      `[csvFormatDetector] Could not parse AI response as JSON: ${raw.slice(0, 200)}`,
    );
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const candidate = parsed as RawSpec;
  if (!isValidSpec(candidate)) {
    console.warn(
      `[csvFormatDetector] AI response failed validation: ${JSON.stringify(candidate).slice(0, 300)}`,
    );
    return null;
  }

  const spec: CsvFormatSpec = {
    preambleRows: candidate.preambleRows,
    hasHeader: candidate.hasHeader,
    dateColumn: candidate.dateColumn,
    descriptionColumn: candidate.descriptionColumn,
    amountColumn: candidate.amountColumn,
    debitColumn: candidate.debitColumn,
    creditColumn: candidate.creditColumn,
    typeColumn: candidate.typeColumn,
    signConvention: candidate.signConvention,
    ...(candidate.dateFormat ? { dateFormat: candidate.dateFormat } : {}),
  };

  console.log(`[csvFormatDetector] AI spec detected: ${JSON.stringify(spec)}`);
  return spec;
}

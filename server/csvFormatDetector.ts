/**
 * Privacy-bounded CSV format request builder.
 *
 * This module does not create an OpenAI client, reserve budget, or decide when
 * assistance is allowed. It only masks a small structural sample, validates a
 * structured response, and executes through the shared bounded provider
 * adapter supplied by the caller.
 */
import type { CsvFormatSpec } from "../shared/schema.js";
import {
  executeOpenAiStructuredRequest,
  type OpenAiChatTransport,
  type OpenAiStructuredRequest,
  type OpenAiStructuredResult,
} from "./openaiProvider.js";

const CSV_FORMAT_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "pocketpulse_csv_format_spec",
    strict: true as const,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        preambleRows: { type: "integer", minimum: 0 },
        hasHeader: { type: "boolean" },
        dateColumn: { type: "integer", minimum: 0 },
        descriptionColumn: { type: "integer", minimum: 0 },
        amountColumn: { type: ["integer", "null"], minimum: 0 },
        debitColumn: { type: ["integer", "null"], minimum: 0 },
        creditColumn: { type: ["integer", "null"], minimum: 0 },
        typeColumn: { type: ["integer", "null"], minimum: 0 },
        signConvention: { type: "string", enum: ["signed", "unsigned"] },
        dateFormat: { type: ["string", "null"], maxLength: 32 },
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
};

const SYSTEM_PROMPT = `You analyze the structure of a financial transaction CSV.
Text and merchant content is already masked. Identify only column roles and the date format.
Use a combined amount column OR separate debit/credit columns, never both.
typeColumn is only for values that directly encode money direction such as Debit/Credit or DR/CR.
Return exactly the requested JSON object with no commentary.`;

const REQUIRED_SPEC_KEYS = new Set([
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
]);

const HEADER_HINTS = [
  "date",
  "posted",
  "posting",
  "transaction",
  "description",
  "merchant",
  "memo",
  "amount",
  "debit",
  "credit",
  "withdrawal",
  "deposit",
];

function looksLikeDate(cell: string): boolean {
  const value = cell.trim();
  if (!value) return false;
  return (
    /^\d{1,4}[\/-]\d{1,2}([\/-]\d{2,4})?$/.test(value) ||
    /^[A-Za-z]+(?:\.|\s)\s*\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}$/i.test(value) ||
    /^\d{1,2}\s+[A-Za-z]+\s+\d{4}$/i.test(value)
  );
}

function looksLikeAmount(cell: string): boolean {
  const value = cell.trim();
  if (!value) return false;
  return /^-?\$?[\d,]+\.?\d*$/.test(value) || /^\([0-9,]+\.?\d*\)$/.test(value);
}

function maskCell(cell: string): string {
  const value = cell.trim();
  if (!value) return '""';
  if (looksLikeDate(value)) return JSON.stringify(value);
  if (looksLikeAmount(value)) {
    const negative = value.startsWith("-") || /^\(.+\)$/.test(value);
    return JSON.stringify(negative ? "-1.00" : "1.00");
  }
  return '"[text]"';
}

function isStructuralHeader(row: string[]): boolean {
  const normalized = row
    .map((cell) => cell.toLowerCase().trim())
    .filter(Boolean);
  if (normalized.length < 2) return false;
  if (normalized.some((cell) => looksLikeDate(cell) || looksLikeAmount(cell))) {
    return false;
  }
  const matches = normalized.filter((cell) =>
    HEADER_HINTS.some((hint) => cell.includes(hint)),
  );
  const hasDate = normalized.some((cell) =>
    ["date", "posted", "posting"].some((hint) => cell.includes(hint)),
  );
  const hasMoney = normalized.some((cell) =>
    ["amount", "debit", "credit", "withdrawal", "deposit"].some((hint) =>
      cell.includes(hint),
    ),
  );
  return matches.length >= 2 && hasDate && hasMoney;
}

function findHeaderRowIndex(rawRows: string[][]): number {
  return rawRows.slice(0, 10).findIndex(isStructuralHeader);
}

function buildMaskedSampleText(rawRows: string[][]): string {
  const headerIndex = findHeaderRowIndex(rawRows);
  return rawRows
    .map((row, index) => {
      const cells =
        index === headerIndex ? row.map((cell) => JSON.stringify(cell)) : row.map(maskCell);
      return `[row ${index}]: ${cells.join(", ")}`;
    })
    .join("\n");
}

export function _findExplicitDirectionColumn(headers: string[]): number {
  const accepted = new Set([
    "credit debit indicator",
    "debit credit indicator",
    "credit/debit indicator",
    "debit/credit indicator",
    "credit debit",
    "debit credit",
    "credit/debit",
    "debit/credit",
    "dr/cr",
  ]);
  return headers.findIndex((header) => accepted.has(header.toLowerCase().trim()));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("CSV format result must be an object");
  }
  return value as Record<string, unknown>;
}

function columnIndex(value: unknown, maxColumns: number, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= maxColumns) {
    throw new Error(`${name} is outside the sampled CSV column range`);
  }
  return Number(value);
}

function nullableColumnIndex(
  value: unknown,
  maxColumns: number,
  name: string,
): number | null {
  return value === null ? null : columnIndex(value, maxColumns, name);
}

function validateSpec(value: unknown, sampleRows: string[][]): CsvFormatSpec {
  const row = asRecord(value);
  if (
    Object.keys(row).length !== REQUIRED_SPEC_KEYS.size ||
    Object.keys(row).some((key) => !REQUIRED_SPEC_KEYS.has(key))
  ) {
    throw new Error("CSV format result has unexpected fields");
  }
  const maxColumns = Math.max(...sampleRows.map((sample) => sample.length));
  const headerIndex = findHeaderRowIndex(sampleRows);
  const preambleRows = headerIndex >= 0 ? headerIndex : 0;
  const hasHeader = headerIndex >= 0;
  const dateColumn = columnIndex(row.dateColumn, maxColumns, "dateColumn");
  const descriptionColumn = columnIndex(
    row.descriptionColumn,
    maxColumns,
    "descriptionColumn",
  );
  const amountColumn = nullableColumnIndex(row.amountColumn, maxColumns, "amountColumn");
  const debitColumn = nullableColumnIndex(row.debitColumn, maxColumns, "debitColumn");
  const creditColumn = nullableColumnIndex(row.creditColumn, maxColumns, "creditColumn");
  const modelTypeColumn = nullableColumnIndex(row.typeColumn, maxColumns, "typeColumn");
  if (dateColumn === descriptionColumn) {
    throw new Error("date and description columns must differ");
  }
  if (amountColumn !== null && (debitColumn !== null || creditColumn !== null)) {
    throw new Error("combined and split amount columns are mutually exclusive");
  }
  if (amountColumn === null && debitColumn === null && creditColumn === null) {
    throw new Error("at least one amount column is required");
  }
  const moneyColumns = [amountColumn, debitColumn, creditColumn].filter(
    (column): column is number => column !== null,
  );
  if (new Set(moneyColumns).size !== moneyColumns.length) {
    throw new Error("money columns must be distinct");
  }
  if (moneyColumns.includes(dateColumn) || moneyColumns.includes(descriptionColumn)) {
    throw new Error("money columns cannot overlap date or description");
  }
  if (row.signConvention !== "signed" && row.signConvention !== "unsigned") {
    throw new Error("signConvention is invalid");
  }
  if (
    row.dateFormat !== null &&
    (typeof row.dateFormat !== "string" ||
      !/^[A-Za-z, ./-]{1,32}$/.test(row.dateFormat))
  ) {
    throw new Error("dateFormat is invalid");
  }
  const explicitDirectionColumn =
    headerIndex >= 0 ? _findExplicitDirectionColumn(sampleRows[headerIndex]!) : -1;
  return {
    preambleRows,
    hasHeader,
    dateColumn,
    descriptionColumn,
    amountColumn,
    debitColumn,
    creditColumn,
    typeColumn:
      explicitDirectionColumn >= 0 ? explicitDirectionColumn : modelTypeColumn,
    signConvention: row.signConvention,
    ...(row.dateFormat ? { dateFormat: row.dateFormat } : {}),
  };
}

function providerRequest(
  sampleRows: string[][],
  model: string,
): OpenAiStructuredRequest<CsvFormatSpec> {
  const sampleText = buildMaskedSampleText(sampleRows);
  return {
    operation: "csv_format_detection",
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Identify the CSV structure from this masked sample:\n\n${sampleText}`,
      },
    ],
    responseFormat: CSV_FORMAT_RESPONSE_FORMAT,
    validate: (value) => validateSpec(value, sampleRows),
  };
}

export async function detectCsvFormat(
  allRows: string[][],
  options: {
    transport: OpenAiChatTransport;
    isEnabled: boolean;
    signal?: AbortSignal;
    model?: string;
  },
): Promise<OpenAiStructuredResult<CsvFormatSpec>> {
  const sampleRows = allRows.slice(0, 8);
  if (sampleRows.length === 0 || sampleRows.every((row) => row.length === 0)) {
    throw new RangeError("CSV sample must contain at least one column");
  }
  return executeOpenAiStructuredRequest(
    providerRequest(
      sampleRows,
      options.model ?? process.env.OPENAI_CSV_FORMAT_MODEL ?? "gpt-5-nano",
    ),
    {
      transport: options.transport,
      isEnabled: options.isEnabled,
      signal: options.signal,
    },
  );
}

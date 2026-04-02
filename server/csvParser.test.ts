import { describe, expect, it } from "vitest";

import { parseCSV, type ParsedRow, type CSVParseResult } from "./csvParser.js";

function makeCsv(lines: string[]): Buffer {
  return Buffer.from(lines.join("\n"), "utf-8");
}

describe("parseCSV", () => {
  it("parses a standard single-amount CSV", async () => {
    const csv = makeCsv([
      "Date,Description,Amount",
      "01/15/2026,NETFLIX INC,-15.99",
      "01/16/2026,PAYROLL DEPOSIT,3500.00",
    ]);

    const result = await parseCSV(csv, "test.csv");

    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };
    expect(rows).toHaveLength(2);
    expect(rows[0]!.date).toBe("2026-01-15");
    expect(rows[0]!.description).toBe("NETFLIX INC");
    expect(rows[0]!.amount).toBe(-15.99);
    expect(rows[1]!.amount).toBe(3500.0);
  });

  it("parses split debit/credit columns", async () => {
    const csv = makeCsv([
      "Date,Description,Debit,Credit",
      "2026-03-01,RENT PAYMENT,1200.00,",
      "2026-03-02,SALARY,,4000.00",
    ]);

    const result = await parseCSV(csv, "test.csv");

    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };
    expect(rows).toHaveLength(2);
    expect(rows[0]!.amount).toBe(-1200.0);
    expect(rows[1]!.amount).toBe(4000.0);
  });

  it("auto-detects columns regardless of case", async () => {
    const csv = makeCsv([
      "DATE,MEMO,AMOUNT",
      "03/20/2026,Coffee Shop,-4.50",
    ]);

    const result = await parseCSV(csv, "test.csv");

    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe("Coffee Shop");
  });

  it("handles 'Transaction Date' and 'Transaction Description' headers", async () => {
    const csv = makeCsv([
      "Transaction Date,Transaction Description,Amount",
      "01/10/2026,AMAZON.COM,-29.99",
    ]);

    const result = await parseCSV(csv, "test.csv");

    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };
    expect(rows[0]!.date).toBe("2026-01-10");
    expect(rows[0]!.description).toBe("AMAZON.COM");
  });

  it("rejects empty files", async () => {
    const result = await parseCSV(Buffer.alloc(0), "empty.csv");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/empty/i);
    }
  });

  it("rejects files with no parseable rows after header", async () => {
    const csv = makeCsv(["Date,Description,Amount"]);
    const result = await parseCSV(csv, "header-only.csv");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no.*rows/i);
    }
  });

  it("rejects files where no date column is detected", async () => {
    const csv = makeCsv([
      "Name,Value",
      "Foo,100",
    ]);
    const result = await parseCSV(csv, "no-date.csv");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/date/i);
    }
  });

  it("rejects files where no amount column is detected", async () => {
    const csv = makeCsv([
      "Date,Name",
      "01/01/2026,Foo",
    ]);
    const result = await parseCSV(csv, "no-amount.csv");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/amount/i);
    }
  });

  it("skips rows with unparseable dates and reports warnings", async () => {
    const csv = makeCsv([
      "Date,Description,Amount",
      "01/15/2026,Good Row,-10.00",
      "bad-date,Bad Row,-5.00",
      "01/17/2026,Another Good,-20.00",
    ]);

    const result = await parseCSV(csv, "test.csv");

    expect(result.ok).toBe(true);
    const r = result as CSVParseResult & { ok: true };
    expect(r.rows).toHaveLength(2);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toMatch(/row 3/i);
  });

  it("skips rows with unparseable amounts and reports warnings", async () => {
    const csv = makeCsv([
      "Date,Description,Amount",
      "01/15/2026,Good Row,-10.00",
      "01/16/2026,Bad Amount,abc",
    ]);

    const result = await parseCSV(csv, "test.csv");

    expect(result.ok).toBe(true);
    const r = result as CSVParseResult & { ok: true };
    expect(r.rows).toHaveLength(1);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("handles quoted fields with commas", async () => {
    const csv = makeCsv([
      'Date,Description,Amount',
      '01/15/2026,"SMITH, JOHN PAYMENT",-500.00',
    ]);

    const result = await parseCSV(csv, "test.csv");

    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };
    expect(rows[0]!.description).toBe("SMITH, JOHN PAYMENT");
  });

  it("handles currency-formatted amounts", async () => {
    const csv = makeCsv([
      "Date,Description,Amount",
      '01/15/2026,Purchase,"$1,234.56"',
    ]);

    const result = await parseCSV(csv, "test.csv");

    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };
    expect(rows[0]!.amount).toBe(1234.56);
  });
});

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

import { parseCSV, type ParsedRow, type CSVParseResult } from "./csvParser.js";

function makeCsv(lines: string[]): Buffer {
  return Buffer.from(lines.join("\n"), "utf-8");
}

function sampleFile(name: string): Buffer {
  return readFileSync(resolve("sample data", name));
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

  it("prefers debit/credit columns over unsigned Amount column", async () => {
    const csv = makeCsv([
      "Date,Description,Amount,Debit,Credit",
      "01/15/2026,NETFLIX INC,15.99,15.99,",
      "01/16/2026,PAYROLL DEPOSIT,3500.00,,3500.00",
    ]);

    const result = await parseCSV(csv, "test.csv");

    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };
    expect(rows).toHaveLength(2);
    expect(rows[0]!.amount).toBe(-15.99);
    expect(rows[1]!.amount).toBe(3500.0);
  });

  it("handles CSV with only unsigned positive amounts (no debit/credit)", async () => {
    const csv = makeCsv([
      "Date,Description,Amount",
      "01/15/2026,NETFLIX INC,15.99",
      "01/16/2026,PAYROLL DEPOSIT,3500.00",
    ]);

    const result = await parseCSV(csv, "test.csv");

    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };
    expect(rows[0]!.amount).toBe(15.99);
    expect(rows[1]!.amount).toBe(3500.0);
  });

  it("detects Type column and uses it for sign (Debit/Credit values)", async () => {
    const csv = makeCsv([
      "Date,Description,Amount,Type",
      "01/15/2026,NETFLIX INC,15.99,Debit",
      "01/16/2026,PAYROLL DEPOSIT,3500.00,Credit",
    ]);

    const result = await parseCSV(csv, "test.csv");

    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };
    expect(rows).toHaveLength(2);
    expect(rows[0]!.amount).toBe(-15.99);
    expect(rows[1]!.amount).toBe(3500.0);
  });

  it("detects Transaction Type column with DR/CR values", async () => {
    const csv = makeCsv([
      "Date,Description,Amount,Transaction Type",
      "01/15/2026,NETFLIX INC,15.99,DR",
      "01/16/2026,PAYROLL DEPOSIT,3500.00,CR",
    ]);

    const result = await parseCSV(csv, "test.csv");

    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };
    expect(rows[0]!.amount).toBe(-15.99);
    expect(rows[1]!.amount).toBe(3500.0);
  });

  // ── Corpus-wide integration check ─────────────────────────────────────────
  // Asserts that every file in the sample data/ folder parses with ok: true.
  // Acts as a regression fence: any new bank format that silently breaks
  // column detection will be caught here before reaching the five targeted tests.
  it("all 30 sample CSV files parse successfully (corpus regression check)", async () => {
    const { readdirSync } = await import("fs");
    const { resolve: res } = await import("path");
    const dir = "sample data";
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".csv"))
      .sort();

    expect(files.length).toBe(30);

    for (const file of files) {
      const buf = readFileSync(res(dir, file));
      const result = await parseCSV(buf, file);
      expect(result.ok, `${file} failed: ${!result.ok ? (result as { ok: false; error: string }).error : ""}`).toBe(true);
      if (result.ok) {
        expect(result.rows.length, `${file} has no rows`).toBeGreaterThan(0);
      }
    }
  });

  // ── DEF-009: Bank of America credit card ───────────────────────────────────
  // "Posted Date" was not in DATE_PATTERNS, causing column detection to fail.
  // "Payee" is the description column; amounts are positive for charges and
  // negative for payments (credit-card convention, ambiguous=true for charges).
  it("DEF-009: parses Bank of America credit card CSV (Posted Date header)", async () => {
    const result = await parseCSV(sampleFile("boa_credit_card.csv"), "boa_credit_card.csv");

    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };

    // 20 data rows in the sample file
    expect(rows).toHaveLength(20);

    // Card charges are positive amounts in BofA CC exports (ambiguous direction)
    const charge = rows.find((r) => r.description === "AMAZON.COM")!;
    expect(charge).toBeDefined();
    expect(charge.amount).toBeGreaterThan(0);
    expect(charge.ambiguous).toBe(true);

    // Payments to the card are negative (unambiguous inflow to the card balance)
    const payment = rows.find((r) => r.description === "PAYMENT THANK YOU")!;
    expect(payment).toBeDefined();
    expect(payment.amount).toBeLessThan(0);
  });

  // ── DEF-010: Wells Fargo (headerless CSV) ─────────────────────────────────
  // Wells Fargo exports have no header row. The parser now detects this via
  // positional fallback: col 0 = date, col 1 = signed amount, col 4 = description.
  it("DEF-010: parses Wells Fargo headerless CSV (positional column fallback)", async () => {
    const result = await parseCSV(sampleFile("wells_fargo_checking.csv"), "wells_fargo_checking.csv");

    expect(result.ok).toBe(true);
    const { rows, warnings } = result as CSVParseResult & { ok: true };

    // 20 data rows (no header to skip)
    expect(rows).toHaveLength(20);

    // Positional fallback emits a warning
    expect(warnings.some((w) => /positional/i.test(w))).toBe(true);

    // Income rows: positive amounts
    const income = rows.find((r) => r.description === "DIRECT DEP US TREASURY VA")!;
    expect(income).toBeDefined();
    expect(income.amount).toBeGreaterThan(0);

    // Expense rows: negative amounts
    const expense = rows.find((r) => r.description === "AUTOZONE")!;
    expect(expense).toBeDefined();
    expect(expense.amount).toBeLessThan(0);
  });

  // ── DEF-011: PNC Bank (Withdrawals / Deposits plural headers) ─────────────
  // PNC uses "Withdrawals" and "Deposits" (plural). The parser previously only
  // matched "withdrawal" and "deposit" (singular), causing amount detection to fail.
  it("DEF-011: parses PNC checking CSV (Withdrawals/Deposits plural headers)", async () => {
    const result = await parseCSV(sampleFile("pnc_checking.csv"), "pnc_checking.csv");

    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };

    // 20 data rows
    expect(rows).toHaveLength(20);

    // Withdrawals become negative amounts
    const withdrawal = rows.find((r) => r.description === "MCDONALD'S")!;
    expect(withdrawal).toBeDefined();
    expect(withdrawal.amount).toBeLessThan(0);

    // Deposits become positive amounts
    const deposit = rows.find((r) => r.description === "ZELLE FROM JOHN DOE")!;
    expect(deposit).toBeDefined();
    expect(deposit.amount).toBeGreaterThan(0);
  });

  // ── DEF-012: Chase checking (ACH_DEBIT / ACH_CREDIT type values) ──────────
  // Chase checking uses "ACH_DEBIT" and "ACH_CREDIT" in the Type column.
  // The parser previously only checked for exact "debit"/"dr"/"deb", so all
  // Chase transactions were treated as positive (income). Amounts are pre-signed
  // in the file; the broadened type check now correctly re-signs them.
  it("DEF-012: parses Chase checking CSV (ACH_DEBIT/ACH_CREDIT type column)", async () => {
    const result = await parseCSV(sampleFile("chase_checking.csv"), "chase_checking.csv");

    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };

    // 20 data rows
    expect(rows).toHaveLength(20);

    // ACH_DEBIT rows must be negative (expenses)
    const expense = rows.find((r) => r.description === "GOOGLE *SERVICES")!;
    expect(expense).toBeDefined();
    expect(expense.amount).toBeLessThan(0);

    // ACH_CREDIT rows must be positive (income)
    const income = rows.find((r) => r.description === "DIRECT DEP EMPLOYER PAYROLL")!;
    expect(income).toBeDefined();
    expect(income.amount).toBeGreaterThan(0);
  });

  // ── DEF-013: Chase credit card (Sale / Payment type values) ───────────────
  // Chase credit card uses "Sale" for purchases and "Payment" for card payments.
  // Previously "Sale" was not recognized as debit, so Math.abs() stripped the
  // negative sign from pre-signed expense amounts, turning all charges into
  // phantom income. The broadened classifier now correctly treats "Sale" as debit
  // and "Payment" as credit.
  it("DEF-013: parses Chase credit card CSV (Sale/Payment type column)", async () => {
    const result = await parseCSV(sampleFile("chase_credit_card.csv"), "chase_credit_card.csv");

    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };

    // 20 data rows
    expect(rows).toHaveLength(20);

    // Sale rows must be negative (card charges / expenses)
    const charge = rows.find((r) => r.description === "KROGER")!;
    expect(charge).toBeDefined();
    expect(charge.amount).toBeLessThan(0);

    // Payment rows must be positive (payment toward the card balance)
    const payment = rows.find((r) => r.description === "PAYMENT THANK YOU")!;
    expect(payment).toBeDefined();
    expect(payment.amount).toBeGreaterThan(0);
  });
});

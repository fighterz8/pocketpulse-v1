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

  // ── BOM stripping ──────────────────────────────────────────────────────────
  // Real BoA exports prepend a UTF-8 BOM (\uFEFF). Without stripping it, the
  // first header cell becomes "\uFEFFDate" instead of "Date", causing column
  // detection to fail. The fix strips the BOM before parsing.
  it("parses a CSV that starts with a UTF-8 BOM (BoA real-world export)", async () => {
    // Prepend BOM bytes (EF BB BF in UTF-8) to a standard BoA checking CSV string
    const csvStr = "\uFEFFDate,Description,Amount,Running Bal.\n" +
      "01/15/2026,NETFLIX INC,-15.99,5000.00\n" +
      "01/16/2026,PAYROLL DEPOSIT,3500.00,8500.00\n";
    const buf = Buffer.from(csvStr, "utf-8");

    const result = await parseCSV(buf, "boa_checking_bom.csv");
    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };
    expect(rows).toHaveLength(2);
    expect(rows[0]!.date).toBe("2026-01-15");
    expect(rows[0]!.description).toBe("NETFLIX INC");
    expect(rows[0]!.amount).toBe(-15.99);
  });

  // ── Preamble-row scanning ──────────────────────────────────────────────────
  // Some BoA export variants begin with 1–2 account-summary lines before the
  // actual column headers. Without preamble-row scanning, the parser treats the
  // first line as the header, fails column detection, and returns an error.
  // The fix scans up to 10 rows looking for a valid header.
  it("parses a CSV with 1 preamble row before the column header (BoA real-world export)", async () => {
    const csvStr =
      // Preamble row — account summary, not a header
      '"Beginning balance as of 01/01/2026","","","5000.00"\n' +
      // Actual column header on row 1
      "Date,Description,Amount,Running Bal.\n" +
      "01/15/2026,NETFLIX INC,-15.99,4984.01\n" +
      "01/16/2026,STARBUCKS,-5.75,4978.26\n";
    const buf = Buffer.from(csvStr, "utf-8");

    const result = await parseCSV(buf, "boa_preamble.csv");
    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };
    expect(rows).toHaveLength(2);
    expect(rows[0]!.date).toBe("2026-01-15");
    expect(rows[0]!.amount).toBe(-15.99);
    // Warning should note that 1 preamble row was skipped
    if (result.ok) {
      expect(result.warnings.some((w) => w.includes("preamble"))).toBe(true);
    }
  });

  // ── DEF-014: BoA 5-row account summary block ───────────────────────────────
  // BoA's default CSV export prepends an "Account Summary" section: a fake
  // header row ("Description,Summary Amt.") plus 4 balance rows, followed by
  // a blank line, then the real transaction header. After skip_empty_lines
  // removes the blank row the real header sits at index 5. The prior scanner
  // limit of 4 meant it was never reached, causing a structural parse error.
  // Fix: MAX_PREAMBLE_ROWS bumped from 4 to 9.
  it("DEF-014: parses BoA CSV with full 5-row account summary block (default export)", async () => {
    const csvStr =
      // Row 0: fake summary header (has "Description" but no date col — fails detection)
      "Description,Summary Amt.\n" +
      // Rows 1–4: balance summary rows
      "Beginning balance as of 01/01/2025,2181.12\n" +
      "Total credits,75160.78\n" +
      "Total debits,77720.69\n" +
      "Ending balance as of 04/30/2025,2621.21\n" +
      // Row 5 (blank): removed by skip_empty_lines, so real header lands at index 5
      "\n" +
      // Real transaction header (index 5 after blank removal)
      "Date,Description,Amount,Running Bal.\n" +
      "1/2/2025,AMAZON RETAIL,-20.60,2160.52\n" +
      "1/6/2025,AMAZON MARKETPLACE,-26.68,2084.84\n";
    const buf = Buffer.from(csvStr, "utf-8");

    const result = await parseCSV(buf, "boa_summary.csv");
    expect(result.ok).toBe(true);
    const { rows, warnings } = result as CSVParseResult & { ok: true };
    expect(rows).toHaveLength(2);
    expect(rows[0]!.date).toBe("2025-01-02");
    expect(rows[0]!.description).toBe("AMAZON RETAIL");
    expect(rows[0]!.amount).toBe(-20.60);
    expect(rows[1]!.amount).toBe(-26.68);
    // 5 preamble rows were skipped
    expect(warnings.some((w) => w.includes("preamble"))).toBe(true);
  });

  // ── DEF-015: BoA Zelle rows with unquoted commas in description ────────────
  // BoA checking CSVs use 4 columns (Date, Description, Amount, Running Bal.).
  // Zelle payment descriptions often contain commas (e.g. "Zelle payment hand
  // soap, body wash." or "Zelle payment Pedro, Christian a...").  Because BoA
  // does not quote these fields in the exported CSV, csv-parse splits the row
  // into 5+ cells. The prior code read the second extra cell as the amount,
  // got NaN, and silently dropped the row.
  // Fix: column-overflow detection joins extra cells back into the description
  // and shifts the amount index rightward by the overflow count.
  it("DEF-015: parses BoA Zelle row with comma in description (column overflow)", async () => {
    // Description "Zelle payment hand soap, body wash." is NOT quoted — BoA
    // exports it as a raw comma, causing a 5-cell row in a 4-column CSV.
    const csvStr =
      "Date,Description,Amount,Running Bal.\n" +
      "5/27/2025,DIRECT DEP EMPLOYER PAYROLL,3393.04,8418.00\n" +
      // Zelle row: unquoted comma splits into 5 cells
      "5/27/2025,Zelle payment hand soap, body wash.,170.00,8588.97\n" +
      "2/4/2026,Zelle payment Pedro, Christian a...,-66.00,3504.96\n";
    const buf = Buffer.from(csvStr, "utf-8");

    const result = await parseCSV(buf, "boa_zelle.csv");
    expect(result.ok).toBe(true);
    const { rows, warnings } = result as CSVParseResult & { ok: true };
    // All 3 rows should parse — no rows dropped
    expect(rows).toHaveLength(3);
    expect(warnings.filter((w) => /skipped/i.test(w))).toHaveLength(0);

    // Zelle payment description should be fully reassembled
    const zelle1 = rows[1]!;
    expect(zelle1.description).toBe("Zelle payment hand soap, body wash.");
    expect(zelle1.amount).toBe(170.00);

    const zelle2 = rows[2]!;
    expect(zelle2.description).toBe("Zelle payment Pedro, Christian a...");
    expect(zelle2.amount).toBe(-66.00);
  });

  // ── DEF-016: BoA unescaped inner quotes inside quoted descriptions ─────────
  // BoA's export tool sometimes embeds a raw " inside a quoted description
  // field (e.g. `"AMAZON RETA* "ZP5RR1WD2" PURCHASE"`). csv-parse reads the
  // inner " as the closing quote of the field, then sees the next character
  // (e.g. "Z") and throws: "Invalid Closing Quote: got 'Z' at line N instead
  // of delimiter". The relax_quotes option does not help here because that
  // flag only loosens rules for unquoted fields, not quoted ones.
  // Fix: a preprocessing regex doubles any " that is clearly mid-field
  // (preceded by a non-delimiter character AND followed by a non-delimiter,
  // non-whitespace, non-quote character) before handing content to csv-parse.
  it("DEF-016: parses BoA CSV with unescaped inner quotes in description fields", async () => {
    const csvStr =
      "Date,Description,Amount,Running Bal.\n" +
      // Standard row — control
      '01/02/2026,"AMAZON.COM","-20.60","2,160.52"\n' +
      // Row with unescaped inner " inside the quoted description
      '01/05/2026,"AMAZON RETA* "ZP5RR1WD2" PURCHASE","-34.99","2,125.53"\n' +
      // Second problematic row — inner " followed by lowercase letter
      '01/10/2026,"PLANET FIT "MEMBERSHIP" JAN","-49.00","2,076.53"\n';
    const buf = Buffer.from(csvStr, "utf-8");

    const result = await parseCSV(buf, "boa_inner_quotes.csv");
    expect(result.ok).toBe(true);
    const { rows } = result as CSVParseResult & { ok: true };

    expect(rows).toHaveLength(3);

    // Control row
    expect(rows[0]!.description).toBe("AMAZON.COM");
    expect(rows[0]!.amount).toBe(-20.60);

    // Inner-quote rows: the description is preserved (inner quotes kept, escaped)
    expect(rows[1]!.description).toMatch(/AMAZON RETA\*/);
    expect(rows[1]!.amount).toBe(-34.99);

    expect(rows[2]!.description).toMatch(/PLANET FIT/);
    expect(rows[2]!.amount).toBe(-49.00);
  });
});

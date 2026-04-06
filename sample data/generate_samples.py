#!/usr/bin/env python3
"""
Generate sample CSV files mimicking the actual download formats
of the top 10 US banks (by assets, consumer-facing).

Each bank gets:
  - checking account CSV
  - savings account CSV  
  - credit card CSV

Format notes sourced from bank documentation, user reports, and export guides.
"""
import csv
import os
import random
from datetime import datetime, timedelta
from io import StringIO

OUTPUT_DIR = "/home/claude/bank_samples/output"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# --- Shared realistic transaction data ---
MERCHANTS = [
    "WALMART SUPERCENTER", "AMAZON.COM", "SHELL OIL", "STARBUCKS",
    "TARGET", "COSTCO WHOLESALE", "WALGREENS", "HOME DEPOT",
    "NETFLIX.COM", "SPOTIFY USA", "UBER TRIP", "DOORDASH",
    "AT&T PAYMENT", "VERIZON WIRELESS", "STATE FARM INSURANCE",
    "HEB GROCERY", "CHICK-FIL-A", "MCDONALD'S", "CVS PHARMACY",
    "AUTOZONE", "PETCO", "APPLE.COM/BILL", "GOOGLE *SERVICES",
    "CHEVRON", "TRADER JOE'S", "WHOLE FOODS MARKET", "ALDI",
    "PUBLIX SUPER MARKETS", "KROGER", "7-ELEVEN"
]

DEPOSIT_DESCS = [
    "DIRECT DEP EMPLOYER PAYROLL",
    "DIRECT DEP US TREASURY VA",
    "MOBILE DEPOSIT",
    "ACH CREDIT VENMO CASHOUT",
    "WIRE TRANSFER IN",
    "ZELLE FROM JOHN DOE",
    "ATM DEPOSIT",
    "INTEREST PAYMENT",
]

CC_CATEGORIES = [
    "Shopping", "Gas/Automotive", "Food & Drink", "Groceries",
    "Entertainment", "Bills & Utilities", "Travel", "Health & Wellness",
    "Personal", "Home"
]

def random_dates(n=20, start_days_ago=60):
    """Generate n sorted random dates within the last start_days_ago days."""
    base = datetime.now()
    dates = sorted([base - timedelta(days=random.randint(1, start_days_ago)) for _ in range(n)])
    return dates

def random_amount(low=-200, high=-5):
    return round(random.uniform(low, high), 2)

def random_deposit():
    return round(random.uniform(50, 3500), 2)

def build_checking_txns(n=20):
    """Return list of (date, description, amount) tuples. Positive=deposit, negative=debit."""
    dates = random_dates(n)
    txns = []
    for d in dates:
        if random.random() < 0.25:
            desc = random.choice(DEPOSIT_DESCS)
            amt = random_deposit()
        else:
            desc = random.choice(MERCHANTS)
            amt = random_amount()
        txns.append((d, desc, amt))
    return txns

def build_cc_txns(n=20):
    dates = random_dates(n)
    txns = []
    for d in dates:
        if random.random() < 0.1:
            desc = "PAYMENT THANK YOU"
            amt = round(random.uniform(100, 2000), 2)
            cat = "Payment/Credit"
        else:
            desc = random.choice(MERCHANTS)
            amt = -round(random.uniform(5, 300), 2)
            cat = random.choice(CC_CATEGORIES)
        txns.append((d, desc, amt, cat))
    return txns


# ============================================================
# 1. CHASE
# Checking CSV: Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
# Credit Card CSV: Transaction Date,Post Date,Description,Category,Type,Amount,Memo
# ============================================================
def chase_checking():
    txns = build_checking_txns()
    bal = 4523.67
    rows = []
    for d, desc, amt in txns:
        bal = round(bal + amt, 2)
        detail = "DEBIT" if amt < 0 else "CREDIT"
        typ = "ACH_DEBIT" if amt < 0 and "DEP" not in desc else ("ACH_CREDIT" if amt > 0 else "DBIT")
        check = "" if "DEPOSIT" not in desc.upper() else ""
        rows.append([detail, d.strftime("%m/%d/%Y"), desc, f"{amt:.2f}", typ, f"{bal:.2f}", check])
    with open(f"{OUTPUT_DIR}/chase_checking.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Details","Posting Date","Description","Amount","Type","Balance","Check or Slip #"])
        w.writerows(rows)

def chase_savings():
    txns = build_checking_txns(10)
    bal = 12450.00
    rows = []
    for d, desc, amt in txns:
        if abs(amt) > 500:
            amt = round(amt * 0.3, 2)
        bal = round(bal + amt, 2)
        detail = "DEBIT" if amt < 0 else "CREDIT"
        typ = "ACH_CREDIT" if amt > 0 else "ACH_DEBIT"
        rows.append([detail, d.strftime("%m/%d/%Y"), desc, f"{amt:.2f}", typ, f"{bal:.2f}", ""])
    with open(f"{OUTPUT_DIR}/chase_savings.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Details","Posting Date","Description","Amount","Type","Balance","Check or Slip #"])
        w.writerows(rows)

def chase_credit_card():
    txns = build_cc_txns()
    rows = []
    for d, desc, amt, cat in txns:
        post = d + timedelta(days=random.randint(0, 2))
        typ = "Sale" if amt < 0 else "Payment"
        rows.append([d.strftime("%m/%d/%Y"), post.strftime("%m/%d/%Y"), desc, cat, typ, f"{amt:.2f}", ""])
    with open(f"{OUTPUT_DIR}/chase_credit_card.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Transaction Date","Post Date","Description","Category","Type","Amount","Memo"])
        w.writerows(rows)


# ============================================================
# 2. BANK OF AMERICA
# Checking/Savings: Date,Description,Amount,Running Bal.
# Credit Card: Posted Date,Reference Number,Payee,Address,Amount
# ============================================================
def boa_checking():
    txns = build_checking_txns()
    bal = 3187.44
    rows = []
    for d, desc, amt in txns:
        bal = round(bal + amt, 2)
        rows.append([d.strftime("%m/%d/%Y"), desc, f"{amt:.2f}", f"{bal:.2f}"])
    with open(f"{OUTPUT_DIR}/boa_checking.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Description","Amount","Running Bal."])
        w.writerows(rows)

def boa_savings():
    txns = build_checking_txns(8)
    bal = 8920.11
    rows = []
    for d, desc, amt in txns:
        if abs(amt) > 500:
            amt = round(amt * 0.2, 2)
        bal = round(bal + amt, 2)
        rows.append([d.strftime("%m/%d/%Y"), desc, f"{amt:.2f}", f"{bal:.2f}"])
    with open(f"{OUTPUT_DIR}/boa_savings.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Description","Amount","Running Bal."])
        w.writerows(rows)

def boa_credit_card():
    txns = build_cc_txns()
    rows = []
    for d, desc, amt, cat in txns:
        ref = f"{random.randint(100000000000, 999999999999)}"
        addr = "CA" if random.random() < 0.5 else "TX"
        rows.append([d.strftime("%m/%d/%Y"), ref, desc, addr, f"{abs(amt):.2f}" if amt < 0 else f"-{amt:.2f}"])
    with open(f"{OUTPUT_DIR}/boa_credit_card.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Posted Date","Reference Number","Payee","Address","Amount"])
        w.writerows(rows)


# ============================================================
# 3. WELLS FARGO
# NO HEADERS - columns: "date","amount","*","check_number","description"
# Single amount column, negative = debit
# ============================================================
def wells_checking():
    txns = build_checking_txns()
    rows = []
    for d, desc, amt in txns:
        check = "" if random.random() < 0.9 else str(random.randint(1001, 9999))
        rows.append([d.strftime("%m/%d/%Y"), f"{amt:.2f}", "*", check, desc])
    with open(f"{OUTPUT_DIR}/wells_fargo_checking.csv", "w", newline="") as f:
        w = csv.writer(f)
        # Wells Fargo notably provides NO header row
        w.writerows(rows)

def wells_savings():
    txns = build_checking_txns(8)
    rows = []
    for d, desc, amt in txns:
        rows.append([d.strftime("%m/%d/%Y"), f"{amt:.2f}", "*", "", desc])
    with open(f"{OUTPUT_DIR}/wells_fargo_savings.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerows(rows)

def wells_credit_card():
    txns = build_cc_txns()
    rows = []
    for d, desc, amt, cat in txns:
        rows.append([d.strftime("%m/%d/%Y"), f"{amt:.2f}", "*", "", desc])
    with open(f"{OUTPUT_DIR}/wells_fargo_credit_card.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerows(rows)


# ============================================================
# 4. CITI
# Checking: Status,Date,Description,Debit,Credit
# Credit Card: Status,Date,Description,Debit,Credit
# ============================================================
def citi_checking():
    txns = build_checking_txns()
    rows = []
    for d, desc, amt in txns:
        debit = f"{abs(amt):.2f}" if amt < 0 else ""
        credit = f"{amt:.2f}" if amt > 0 else ""
        rows.append(["Cleared", d.strftime("%m/%d/%Y"), desc, debit, credit])
    with open(f"{OUTPUT_DIR}/citi_checking.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Status","Date","Description","Debit","Credit"])
        w.writerows(rows)

def citi_savings():
    txns = build_checking_txns(8)
    rows = []
    for d, desc, amt in txns:
        debit = f"{abs(amt):.2f}" if amt < 0 else ""
        credit = f"{amt:.2f}" if amt > 0 else ""
        rows.append(["Cleared", d.strftime("%m/%d/%Y"), desc, debit, credit])
    with open(f"{OUTPUT_DIR}/citi_savings.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Status","Date","Description","Debit","Credit"])
        w.writerows(rows)

def citi_credit_card():
    txns = build_cc_txns()
    rows = []
    for d, desc, amt, cat in txns:
        debit = f"{abs(amt):.2f}" if amt < 0 else ""
        credit = f"{amt:.2f}" if amt > 0 else ""
        rows.append(["Cleared", d.strftime("%m/%d/%Y"), desc, debit, credit])
    with open(f"{OUTPUT_DIR}/citi_credit_card.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Status","Date","Description","Debit","Credit"])
        w.writerows(rows)


# ============================================================
# 5. US BANK
# Date,Transaction,Name,Memo,Amount
# ============================================================
def usbank_checking():
    txns = build_checking_txns()
    rows = []
    for d, desc, amt in txns:
        txn_type = "DEBIT" if amt < 0 else "CREDIT"
        memo = "PURCHASE" if amt < 0 else "DEPOSIT"
        rows.append([d.strftime("%Y-%m-%d"), txn_type, desc, memo, f"{amt:.2f}"])
    with open(f"{OUTPUT_DIR}/usbank_checking.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Transaction","Name","Memo","Amount"])
        w.writerows(rows)

def usbank_savings():
    txns = build_checking_txns(8)
    rows = []
    for d, desc, amt in txns:
        txn_type = "DEBIT" if amt < 0 else "CREDIT"
        memo = "WITHDRAWAL" if amt < 0 else "DEPOSIT"
        rows.append([d.strftime("%Y-%m-%d"), txn_type, desc, memo, f"{amt:.2f}"])
    with open(f"{OUTPUT_DIR}/usbank_savings.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Transaction","Name","Memo","Amount"])
        w.writerows(rows)

def usbank_credit_card():
    txns = build_cc_txns()
    rows = []
    for d, desc, amt, cat in txns:
        txn_type = "SALE" if amt < 0 else "PAYMENT"
        rows.append([d.strftime("%Y-%m-%d"), txn_type, desc, cat, f"{amt:.2f}"])
    with open(f"{OUTPUT_DIR}/usbank_credit_card.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Transaction","Name","Memo","Amount"])
        w.writerows(rows)


# ============================================================
# 6. CAPITAL ONE
# Checking: Account Number,Transaction Date,Transaction Amount,Transaction Type,Transaction Description,Balance
# Credit Card: Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
# ============================================================
def capone_checking():
    txns = build_checking_txns()
    bal = 2845.90
    acct = "3948XXXXXX7721"
    rows = []
    for d, desc, amt in txns:
        bal = round(bal + amt, 2)
        typ = "Debit" if amt < 0 else "Credit"
        rows.append([acct, d.strftime("%m/%d/%Y"), f"{amt:.2f}", typ, desc, f"{bal:.2f}"])
    with open(f"{OUTPUT_DIR}/capital_one_checking.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Account Number","Transaction Date","Transaction Amount","Transaction Type","Transaction Description","Balance"])
        w.writerows(rows)

def capone_savings():
    txns = build_checking_txns(8)
    bal = 15200.00
    acct = "3948XXXXXX8832"
    rows = []
    for d, desc, amt in txns:
        bal = round(bal + amt, 2)
        typ = "Debit" if amt < 0 else "Credit"
        rows.append([acct, d.strftime("%m/%d/%Y"), f"{amt:.2f}", typ, desc, f"{bal:.2f}"])
    with open(f"{OUTPUT_DIR}/capital_one_savings.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Account Number","Transaction Date","Transaction Amount","Transaction Type","Transaction Description","Balance"])
        w.writerows(rows)

def capone_credit_card():
    txns = build_cc_txns()
    rows = []
    card = "4147XXXXXXXX9023"
    for d, desc, amt, cat in txns:
        post = d + timedelta(days=random.randint(0, 2))
        debit = f"{abs(amt):.2f}" if amt < 0 else ""
        credit = f"{amt:.2f}" if amt > 0 else ""
        rows.append([d.strftime("%Y-%m-%d"), post.strftime("%Y-%m-%d"), card, desc, cat, debit, credit])
    with open(f"{OUTPUT_DIR}/capital_one_credit_card.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Transaction Date","Posted Date","Card No.","Description","Category","Debit","Credit"])
        w.writerows(rows)


# ============================================================
# 7. PNC
# Date,Description,Withdrawals,Deposits,Balance
# ============================================================
def pnc_checking():
    txns = build_checking_txns()
    bal = 3650.22
    rows = []
    for d, desc, amt in txns:
        bal = round(bal + amt, 2)
        wd = f"{abs(amt):.2f}" if amt < 0 else ""
        dep = f"{amt:.2f}" if amt > 0 else ""
        rows.append([d.strftime("%m/%d/%Y"), desc, wd, dep, f"{bal:.2f}"])
    with open(f"{OUTPUT_DIR}/pnc_checking.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Description","Withdrawals","Deposits","Balance"])
        w.writerows(rows)

def pnc_savings():
    txns = build_checking_txns(8)
    bal = 7800.00
    rows = []
    for d, desc, amt in txns:
        bal = round(bal + amt, 2)
        wd = f"{abs(amt):.2f}" if amt < 0 else ""
        dep = f"{amt:.2f}" if amt > 0 else ""
        rows.append([d.strftime("%m/%d/%Y"), desc, wd, dep, f"{bal:.2f}"])
    with open(f"{OUTPUT_DIR}/pnc_savings.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Description","Withdrawals","Deposits","Balance"])
        w.writerows(rows)

def pnc_credit_card():
    txns = build_cc_txns()
    rows = []
    for d, desc, amt, cat in txns:
        wd = f"{abs(amt):.2f}" if amt < 0 else ""
        dep = f"{amt:.2f}" if amt > 0 else ""
        rows.append([d.strftime("%m/%d/%Y"), desc, wd, dep, ""])
    with open(f"{OUTPUT_DIR}/pnc_credit_card.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Description","Withdrawals","Deposits","Balance"])
        w.writerows(rows)


# ============================================================
# 8. TRUIST
# Date,Description,Amount,Running Balance
# (single signed amount column)
# ============================================================
def truist_checking():
    txns = build_checking_txns()
    bal = 5120.33
    rows = []
    for d, desc, amt in txns:
        bal = round(bal + amt, 2)
        rows.append([d.strftime("%m/%d/%Y"), desc, f"{amt:.2f}", f"{bal:.2f}"])
    with open(f"{OUTPUT_DIR}/truist_checking.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Description","Amount","Running Balance"])
        w.writerows(rows)

def truist_savings():
    txns = build_checking_txns(8)
    bal = 10300.00
    rows = []
    for d, desc, amt in txns:
        bal = round(bal + amt, 2)
        rows.append([d.strftime("%m/%d/%Y"), desc, f"{amt:.2f}", f"{bal:.2f}"])
    with open(f"{OUTPUT_DIR}/truist_savings.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Description","Amount","Running Balance"])
        w.writerows(rows)

def truist_credit_card():
    txns = build_cc_txns()
    rows = []
    for d, desc, amt, cat in txns:
        post = d + timedelta(days=random.randint(0, 2))
        rows.append([d.strftime("%m/%d/%Y"), post.strftime("%m/%d/%Y"), desc, f"{amt:.2f}"])
    with open(f"{OUTPUT_DIR}/truist_credit_card.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Transaction Date","Posted Date","Description","Amount"])
        w.writerows(rows)


# ============================================================
# 9. TD BANK
# Date,Activity,Description,Debit Amount,Credit Amount
# (separate debit/credit columns, no negative signs)
# ============================================================
def td_checking():
    txns = build_checking_txns()
    rows = []
    for d, desc, amt in txns:
        activity = "ACH Debit" if amt < 0 else "ACH Credit"
        debit = f"{abs(amt):.2f}" if amt < 0 else ""
        credit = f"{amt:.2f}" if amt > 0 else ""
        rows.append([d.strftime("%m/%d/%Y"), activity, desc, debit, credit])
    with open(f"{OUTPUT_DIR}/td_bank_checking.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Activity","Description","Debit Amount","Credit Amount"])
        w.writerows(rows)

def td_savings():
    txns = build_checking_txns(8)
    rows = []
    for d, desc, amt in txns:
        activity = "ACH Debit" if amt < 0 else "ACH Credit"
        debit = f"{abs(amt):.2f}" if amt < 0 else ""
        credit = f"{amt:.2f}" if amt > 0 else ""
        rows.append([d.strftime("%m/%d/%Y"), activity, desc, debit, credit])
    with open(f"{OUTPUT_DIR}/td_bank_savings.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Activity","Description","Debit Amount","Credit Amount"])
        w.writerows(rows)

def td_credit_card():
    txns = build_cc_txns()
    rows = []
    for d, desc, amt, cat in txns:
        activity = "Purchase" if amt < 0 else "Payment"
        debit = f"{abs(amt):.2f}" if amt < 0 else ""
        credit = f"{amt:.2f}" if amt > 0 else ""
        rows.append([d.strftime("%m/%d/%Y"), activity, desc, debit, credit])
    with open(f"{OUTPUT_DIR}/td_bank_credit_card.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Activity","Description","Debit Amount","Credit Amount"])
        w.writerows(rows)


# ============================================================
# 10. FIFTH THIRD
# Date,Description,Amount,Balance
# (single signed amount)
# ============================================================
def fifth_third_checking():
    txns = build_checking_txns()
    bal = 2987.15
    rows = []
    for d, desc, amt in txns:
        bal = round(bal + amt, 2)
        rows.append([d.strftime("%m/%d/%Y"), desc, f"{amt:.2f}", f"{bal:.2f}"])
    with open(f"{OUTPUT_DIR}/fifth_third_checking.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Description","Amount","Balance"])
        w.writerows(rows)

def fifth_third_savings():
    txns = build_checking_txns(8)
    bal = 6500.00
    rows = []
    for d, desc, amt in txns:
        bal = round(bal + amt, 2)
        rows.append([d.strftime("%m/%d/%Y"), desc, f"{amt:.2f}", f"{bal:.2f}"])
    with open(f"{OUTPUT_DIR}/fifth_third_savings.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Description","Amount","Balance"])
        w.writerows(rows)

def fifth_third_credit_card():
    txns = build_cc_txns()
    rows = []
    for d, desc, amt, cat in txns:
        rows.append([d.strftime("%m/%d/%Y"), desc, f"{amt:.2f}"])
    with open(f"{OUTPUT_DIR}/fifth_third_credit_card.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Date","Description","Amount"])
        w.writerows(rows)


# ============================================================
# RUN ALL
# ============================================================
if __name__ == "__main__":
    random.seed(42)  # reproducible

    chase_checking(); chase_savings(); chase_credit_card()
    boa_checking(); boa_savings(); boa_credit_card()
    wells_checking(); wells_savings(); wells_credit_card()
    citi_checking(); citi_savings(); citi_credit_card()
    usbank_checking(); usbank_savings(); usbank_credit_card()
    capone_checking(); capone_savings(); capone_credit_card()
    pnc_checking(); pnc_savings(); pnc_credit_card()
    truist_checking(); truist_savings(); truist_credit_card()
    td_checking(); td_savings(); td_credit_card()
    fifth_third_checking(); fifth_third_savings(); fifth_third_credit_card()

    print("Generated 30 sample CSV files:")
    for f in sorted(os.listdir(OUTPUT_DIR)):
        path = os.path.join(OUTPUT_DIR, f)
        lines = open(path).readlines()
        print(f"  {f:40s} ({len(lines)} rows)")

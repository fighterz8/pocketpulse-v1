# Bank CSV Sample Data — Top 10 US Banks

## Format Reference

| Bank | Headers? | Date Format | Amount Style | Columns (Checking) |
|------|----------|-------------|-------------|-------------------|
| **Chase** | Yes | MM/DD/YYYY | Signed single column | Details, Posting Date, Description, Amount, Type, Balance, Check or Slip # |
| **Bank of America** | Yes | MM/DD/YYYY | Signed single column | Date, Description, Amount, Running Bal. |
| **Wells Fargo** | **NO** | MM/DD/YYYY | Signed single column | (date, amount, *, check#, description) |
| **Citi** | Yes | MM/DD/YYYY | Split Debit/Credit | Status, Date, Description, Debit, Credit |
| **US Bank** | Yes | YYYY-MM-DD | Signed single column | Date, Transaction, Name, Memo, Amount |
| **Capital One** | Yes | MM/DD/YYYY | Signed single column | Account Number, Transaction Date, Transaction Amount, Transaction Type, Transaction Description, Balance |
| **PNC** | Yes | MM/DD/YYYY | Split Withdrawals/Deposits | Date, Description, Withdrawals, Deposits, Balance |
| **Truist** | Yes | MM/DD/YYYY | Signed single column | Date, Description, Amount, Running Balance |
| **TD Bank** | Yes | MM/DD/YYYY | Split Debit/Credit | Date, Activity, Description, Debit Amount, Credit Amount |
| **Fifth Third** | Yes | MM/DD/YYYY | Signed single column | Date, Description, Amount, Balance |

## Key Differences for Parser Design

1. **Header presence**: Wells Fargo is the outlier — no header row at all.
2. **Amount representation**: Three patterns:
   - Single signed column (Chase, BoA, Wells, US Bank, Truist, Fifth Third) — negative = debit
   - Split debit/credit columns (Citi, TD Bank)
   - Split withdrawals/deposits (PNC)
   - Capital One CC uses split; checking uses signed
3. **Date formats**: US Bank uses ISO (YYYY-MM-DD); all others use MM/DD/YYYY.
4. **Credit card vs checking differences**: Chase, Capital One, and Truist use different column schemas for CC vs checking. Others use the same schema.
5. **Extra fields**: Chase includes "Type" and "Check or Slip #"; Capital One includes masked account/card numbers; BoA CC includes reference numbers and addresses.

## Files Included

30 CSV files total — 3 per bank (checking, savings, credit card):
- `{bank}_checking.csv`
- `{bank}_savings.csv`  
- `{bank}_credit_card.csv`

Plus the generator script (`generate_samples.py`) for reproducibility.

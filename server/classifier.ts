/**
 * Structural keyword classifier. Merchant-specific keywords live in
 * merchant_classifications_global (seeded at boot from classifierRuleMigration.ts).
 * Resolution order: per-user cache → global seed → these rules → AI.
 */
import type { V1Category } from "../shared/schema.js";
import { getDirectionHint, isDebitCardDescription, normalizeMerchant } from "./transactionUtils.js";

// prettier-ignore
const TRANSFER_KW = [
  "transfer","xfer","zelle","venmo","cash app","cashapp","wire","paypal",
  "apple pay","google pay","samsung pay","peer transfer","p2p","remittance",
  "western union","moneygram","wise transfer","revolut","mobile deposit",
  "edeposit","e-deposit","mobile check deposit","remote deposit",
];
const P2P_DEBIT_EXEMPT: ReadonlySet<string> = new Set(["cash app","cashapp","venmo","zelle"]);

export type ClassificationResult = {
  transactionClass: "income" | "expense" | "transfer" | "refund";
  flowType: "inflow" | "outflow";
  category: V1Category;
  recurrenceType: "recurring" | "one-time";
  recurrenceSource: "none" | "hint" | "detected";
  merchant: string;
  labelSource: "rule";
  labelConfidence: number;
  labelReason: string;
  /** Whether the class came from transaction semantics or only amount sign. */
  classEvidence: "explicit" | "heuristic";
  aiAssisted: boolean;
};

type CR = {
  category: V1Category; keywords: string[]; confidence: number;
  transactionClass?: "expense" | "income"; recurrenceType?: "recurring" | "one-time";
};

// Structural rules only — no brand names. Brand→category mapping is in the global seed.
// prettier-ignore
const CATEGORY_RULES: CR[] = [
  { category: "debt", transactionClass: "expense", recurrenceType: "recurring", confidence: 0.92, keywords: [
    "loan payment","loan repayment","personal loan","student loan","auto loan","car payment",
    "car loan","vehicle loan","vehicle payment","auto payment","mortgage payment","home loan",
    "heloc","credit card payment","credit card pymt","payment to credit card","card payment",
    "payment to loan","payment to auto","payment to mortgage","transfer to mortgage",
  ]},
  { category: "fees", transactionClass: "expense", confidence: 0.88, keywords: [
    "atm withdrawal","cash withdrawal","atm/cash","nsf fee","overdraft fee","monthly fee","service charge","maintenance fee",
  ]},
  { category: "insurance", recurrenceType: "recurring", confidence: 0.90, keywords: ["insurance"] },
  { category: "housing", recurrenceType: "recurring", confidence: 0.90, keywords: [
    "rent payment","monthly rent","apartment rent","mortgage","hoa dues","home loan payment",
    "loan servicing","mtg pymt","mortgage pymt",
  ]},
  { category: "housing",    confidence: 0.80, keywords: [
    "rent","mortgage","hoa","homeowner","property tax","landlord","apartment","realty",
    "real estate","property management","maintenance","pest control","lawn","landscaping",
    "cleaning service","maid","loan servicing","mtg pymt","mortgage pymt",
  ]},
  { category: "utilities", recurrenceType: "recurring", confidence: 0.85, keywords: [
    "electric","electricity","water bill","water dept","water utility","gas co","gas company",
    "natural gas","sewer","utility","utilities","power","energy","internet","broadband",
    "phone bill","cell phone","wireless bill","trash","recycling","propane",
  ]},
  { category: "travel",   confidence: 0.85, keywords: ["airline","airways","hotel"] },
  { category: "gas",      confidence: 0.85, keywords: ["gas station","fuel","gasoline","petrol"] },
  { category: "parking",  confidence: 0.85, keywords: ["parking","park & ride"] },
  { category: "auto",     confidence: 0.80, keywords: [
    "uber","lyft","taxi","cab ","rideshare","toll","e-zpass","ezpass","fastrak","sunpass",
    "metro","subway train","bart ","mta ","transit","bus pass","train ticket","car wash",
    "auto parts","oil change","tire","auto repair","brake","mechanic","dealership",
    "dmv","motor vehicle","vehicle registration","towing","roadside assistance","aaa ",
  ]},
  { category: "groceries", confidence: 0.85, keywords: ["grocery","supermarket"] },
  { category: "coffee",    confidence: 0.85, keywords: ["coffee shop","cafe ","espresso"] },
  { category: "dining",   confidence: 0.80, keywords: [
    "restaurant","pizza","burger","grill ","kitchen","bakery","sushi","thai food",
    "chinese food","indian food","pho","ramen","diner","bar & grill","pub ","tavern",
    "bistro","brasserie","trattoria","cantina","taproom","brew pub","bbq","barbeque",
    "steakhouse","seafood","wings","noodle","taqueria","burrito","wrap","smoothie",
    "juice bar","boba","donut","bagel","deli","sandwich","sub shop","catering","eat ","snack",
    "toast tab","toasttab","olo.com",
  ]},
  { category: "medical",  confidence: 0.80, keywords: [
    "pharmacy","doctor","physician","medical","hospital","dental","dentist","orthodont",
    "optometry","optometrist","vision care","urgent care","clinic","therapy","therapist",
    "counseling","psychiatry","psychology","mental health","lab work","blood test",
    "x-ray","radiology","surgery","anesthesia","copay","co-pay","prescription",
    "rx","vitamin","supplement","healthcare",
  ]},
  { category: "fitness",  recurrenceType: "recurring", confidence: 0.82, keywords: [
    "gym","fitness","pilates","yoga","massage","chiropractor","physical therapy","rehabilitation",
  ]},
  { category: "software", recurrenceType: "recurring", confidence: 0.90, keywords: ["subscription"] },
  { category: "shopping", confidence: 0.72, keywords: [
    "tuition","university","college","school fees","textbook","bookstore","student fee","enrollment fee","campus",
  ]},
  { category: "shopping", confidence: 0.78, keywords: [
    "daycare","day care","childcare","child care","babysitter","nanny","au pair",
    "preschool","nursery school","after school","summer camp",
  ]},
  { category: "shopping", confidence: 0.68, keywords: ["donation","donate","charity","charitable","nonprofit","non-profit"] },
  { category: "fees",     confidence: 0.90, keywords: [
    "fee","overdraft","nsf","non-sufficient","insufficient fund","late charge","late fee",
    "service charge","annual fee","maintenance fee","monthly fee","account fee","atm fee",
    "wire fee","foreign transaction","currency conversion","cash advance fee",
    "returned check","stop payment","penalty","fine ","bank charge",
  ]},
  { category: "entertainment", confidence: 0.75, keywords: [
    "theatre","theater","concert","bowling","arcade","museum","zoo ","aquarium","amusement park",
    "golf","mini golf","go-kart","escape room","laser tag","trampoline","paintball","rock climbing",
    "comedy club","improv","nightclub","club cover","bar tab","karaoke","billiards","pool hall",
  ]},
];

function esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function re(kw: string) {
  const t = kw.trim();
  return new RegExp((/^\w/.test(t) ? "\\b" : "") + esc(kw) + (/\w$/.test(t) ? "\\b" : ""), "i");
}
type CCR = CR & { compiled: RegExp[] };
const RULES: CCR[] = CATEGORY_RULES.map((r) => ({ ...r, compiled: r.keywords.map(re) }));
const NON_EXP: ReadonlySet<string> = new Set(["transfers", "income", "other"]);
const EXP_CATS: ReadonlySet<string> = new Set(CATEGORY_RULES.map((r) => r.category).filter((c) => !NON_EXP.has(c)));

const REFUND_KW  = ["refund","return credit","credit adj","reversal","chargeback","adjustment cr"];
const INCOME_KW  = ["deposit","payment received","direct dep","ach credit","wire from","invoice"];
const REC_INC_KW = ["salary","payroll","direct deposit","regular income","benefit","benefits",
                    "pension","social security","veteran affairs","dept. of veterans","department of veteran","thrift savings"];

export function classifyTransaction(rawDescription: string, amount: number): ClassificationResult {
  const lower = rawDescription.toLowerCase().trim();
  const directionHint = getDirectionHint(rawDescription);
  const cleanedMerchant = normalizeMerchant(rawDescription);
  const isDebit = isDebitCardDescription(rawDescription);

  let tc: ClassificationResult["transactionClass"] = amount >= 0 ? "income" : "expense";
  let flowType: "inflow" | "outflow" = amount >= 0 ? "inflow" : "outflow";
  let recurrenceType: "recurring" | "one-time" = "one-time";
  let recurrenceSource: "none" | "hint" | "detected" = "none";
  let category: V1Category = amount >= 0 ? "income" : "other";
  let labelReason = "amount-sign heuristic";
  let classEvidence: ClassificationResult["classEvidence"] = "heuristic";
  let matchedRule = false;
  let labelConfidence = 0.92;

  // Pass 1: transfers
  if (TRANSFER_KW.some((kw) => lower.includes(kw))) {
    const exempt = isDebit && [...P2P_DEBIT_EXEMPT].some((kw) => lower.includes(kw));
    if (!exempt) { tc = "transfer"; category = "other"; classEvidence = "explicit"; }
  }
  // Pass 2: refunds
  if (tc !== "transfer" && REFUND_KW.some((kw) => lower.includes(kw))) {
    tc = "refund";
    classEvidence = "explicit";
  }
  // Pass 3: income
  if (tc !== "transfer" && tc !== "refund" && amount >= 0 && INCOME_KW.some((kw) => lower.includes(kw))) {
    tc = "income"; category = "income";
    classEvidence = "explicit";
  }
  // Pass 3b: direction-hint correction
  if (tc === "income" && amount >= 0 && directionHint === "outflow") {
    tc = "expense"; flowType = "outflow"; category = "other";
    classEvidence = "explicit";
    labelReason = "direction-hint correction";
  }
  // Pass 4: standalone "credit" keyword
  const hasIncomeCtx = INCOME_KW.some((kw) => lower.includes(kw));
  if (/(^|\s)credit($|\s)/.test(lower) && amount > 0 && !hasIncomeCtx && tc !== "transfer") {
    tc = "refund";
    classEvidence = "explicit";
  }
  // Pass 5: transfer direction
  if (tc === "transfer" && directionHint) flowType = directionHint;

  // Pass 6: structural keyword matching
  outer: for (const rule of RULES) {
    for (let ki = 0; ki < rule.compiled.length; ki++) {
      if (!rule.compiled[ki]!.test(lower)) continue;
      category = rule.category;
      matchedRule = true;
      labelConfidence = rule.confidence;
      labelReason = `keyword "${rule.keywords[ki]!}" → ${category}`;
      if (rule.transactionClass) {
        tc = rule.transactionClass;
        classEvidence = "explicit";
      } else if (EXP_CATS.has(rule.category) && tc === "income") {
        tc = "expense";
        classEvidence = "explicit";
      }
      if (tc === "expense") flowType = "outflow";
      else if (tc === "income") flowType = "inflow";
      if (rule.recurrenceType) recurrenceType = rule.recurrenceType;
      if (rule.recurrenceType === "recurring") recurrenceSource = "hint";
      break outer;
    }
  }

  // Pass 8: subscription/recurring hints
  if (recurrenceType === "one-time" && tc !== "transfer" && tc !== "refund") {
    if (["subscription","monthly","recurring","membership"].some((kw) => lower.includes(kw))) {
      recurrenceType = "recurring"; recurrenceSource = "hint";
    }
  }
  // Pass 9: recurring income
  if (recurrenceType === "one-time" && tc === "income" && REC_INC_KW.some((kw) => lower.includes(kw))) {
    recurrenceType = "recurring"; recurrenceSource = "hint";
  }
  // Pass 11: income lock
  if (tc === "income") { category = "income"; flowType = "inflow"; }

  // A refund is an inflow that reverses a prior expense, not income. Until a
  // merchant rule/cache/AI can recover the original spending category, keep
  // the category explicitly unresolved so the pipeline queues enrichment.
  if (tc === "refund" && category === "income") category = "other";

  const unresolvedCategory = category === "other" && tc !== "transfer";
  const aiAssisted =
    !matchedRule &&
    tc !== "transfer" &&
    (unresolvedCategory ||
      (recurrenceType === "one-time" && !directionHint));
  if (!matchedRule) {
    labelConfidence = aiAssisted ? 0.55 : 0.75;
    labelReason = aiAssisted ? "no keyword matched" : `amount-sign → ${category}`;
  }

  return { transactionClass: tc, flowType, category, recurrenceType, recurrenceSource,
    merchant: cleanedMerchant, labelSource: "rule", labelConfidence, labelReason,
    classEvidence, aiAssisted };
}

/**
 * Rules-based transaction classifier.
 *
 * Assigns category, transaction class, recurrence hints, and a human-readable
 * label reason using keyword matching against the merchant name. Rules are
 * intentionally deterministic and explainable (V1 spec section 10.2).
 *
 * The keyword tables below drive classification. Each entry maps a set of
 * merchant substrings to a category. Order matters: the first matching rule
 * wins, so more specific patterns should appear before broader ones.
 */
import type { V1Category } from "../shared/schema.js";
import { getDirectionHint, normalizeMerchant } from "./transactionUtils.js";

const TRANSFER_KEYWORDS = [
  "transfer",
  "xfer",
  "zelle",
  "venmo",
  "cash app",
  "cashapp",
  "wire",
  "paypal",
  "apple pay",
  "google pay",
  "samsung pay",
  "peer transfer",
  "p2p",
  "remittance",
  "western union",
  "moneygram",
  "wise transfer",
  "revolut",
];

/**
 * Result produced by classifyTransaction(). The classifier now fully owns
 * flowType (no more flowOverride to reconcile at the call site), and exposes
 * the cleaned merchant name and the aiAssisted flag so callers can determine
 * which rows need LLM enrichment without additional logic.
 */
export type ClassificationResult = {
  transactionClass: "income" | "expense" | "transfer" | "refund";
  flowType: "inflow" | "outflow";
  category: V1Category;
  recurrenceType: "recurring" | "one-time";
  merchant: string;
  labelSource: "rule";
  labelConfidence: number;
  labelReason: string;
  /**
   * True when no specific merchant rule matched AND no recurring signal was
   * found AND no strong directional language appeared in the description.
   * When true the LLM enrichment layer should review this row.
   */
  aiAssisted: boolean;
};

type CategoryRule = {
  category: V1Category;
  keywords: string[];
  confidence: number;
  /**
   * Optional explicit transaction-class override. Set this on categories
   * (e.g. "debt") where a rule match should always produce the given class
   * regardless of what earlier passes (transfer detection, income detection)
   * decided. When omitted, any category in EXPENSE_CATEGORIES auto-locks to
   * "expense" during Pass 6.
   */
  transactionClass?: "expense" | "income";
  /**
   * Optional explicit recurrence hint. When set the merchant rule wins over
   * the Pass 8 subscription-keyword heuristic.
   */
  recurrenceType?: "recurring" | "one-time";
};

/**
 * Keyword rules ordered from specific to general. Each keyword is matched
 * as a case-insensitive substring of the merchant name.
 */
const CATEGORY_RULES: CategoryRule[] = [
  // Transfers (check before income — "transfer" can appear in inflows too)
  {
    category: "transfers",
    keywords: TRANSFER_KEYWORDS,
    confidence: 0.85,
  },

  // Debt payments. transactionClass is explicitly set to "expense" so that
  // "TRANSFER TO AUTO LOAN" (which matches Pass 1 transfer detection) is
  // correctly overridden back to expense in Pass 6. Without the explicit
  // transactionClass here the auto-lock would not fire because the
  // transactionClass from Pass 1 is "transfer", not "income".
  {
    category: "debt",
    transactionClass: "expense",
    keywords: [
      "loan payment",
      "student loan",
      "auto loan",
      "car payment",
      "car loan",
      "vehicle loan",
      "vehicle payment",
      "auto payment",
      "mortgage payment",
      "home loan",
      "heloc",
      "credit card payment",
      "credit card pymt",
      "card payment",
      "payment to loan",
      "payment to auto",
      "payment to mortgage",
      "transfer to loan",
      "transfer to auto",
      "transfer to mortgage",
      "sallie mae",
      "navient",
      "great lakes",
      "fedloan",
      "mohela",
      "nelnet",
      "aidvantage",
      "edfinancial",
      "discover student",
      "sofi loan",
      "earnest loan",
      "personal loan",
      "debt",
    ],
    confidence: 0.9,
  },

  // Insurance (before housing — hoa could match "insurance")
  {
    category: "insurance",
    keywords: [
      "insurance",
      "geico",
      "state farm",
      "allstate",
      "progressive",
      "liberty mutual",
      "usaa",
      "nationwide",
      "farmers",
      "metlife",
      "aetna",
      "cigna",
      "blue cross",
      "bluecross",
      "anthem",
      "united health",
      "unitedhealthcare",
      "humana",
      "oscar health",
      "kaiser permanente",
      "hartford insurance",
      "travelers insurance",
      "chubb",
      "erie insurance",
      "lemonade insurance",
      "root insurance",
      "hippo insurance",
      "esurance",
      "21st century insurance",
      "safeco",
    ],
    confidence: 0.9,
  },

  // Subscriptions & streaming (before business_software so netflix etc. win)
  {
    category: "subscriptions",
    keywords: [
      "netflix",
      "spotify",
      "hulu",
      "disney+",
      "disney plus",
      "disneyplus",
      "apple music",
      "apple tv",
      "apple one",
      "youtube premium",
      "youtube music",
      "hbo max",
      "max.com",
      "paramount+",
      "paramount plus",
      "peacock",
      "peacocktv",
      "audible",
      "kindle unlimited",
      "amazon prime",
      "amazon music",
      "siriusxm",
      "pandora",
      "tidal",
      "deezer",
      "icloud",
      "google one",
      "google storage",
      "microsoft 365",
      "office 365",
      "xbox game pass",
      "playstation plus",
      "nintendo switch online",
      "crunchyroll",
      "funimation",
      "mubi",
      "criterion",
      "discovery+",
      "espn+",
      "fubo",
      "philo",
      "sling tv",
      "directv stream",
      "subscription",
      "substack",
      "patreon",
      "onlyfans",
      "masterclass",
    ],
    confidence: 0.9,
  },

  // Business software / SaaS
  {
    category: "business_software",
    keywords: [
      "github",
      "gitlab",
      "heroku",
      "aws ",
      "amazon web services",
      "google cloud",
      "gcp ",
      "azure ",
      "digitalocean",
      "vercel",
      "netlify",
      "render.com",
      "railway",
      "fly.io",
      "supabase",
      "planetscale",
      "neon.tech",
      "slack",
      "zoom",
      "notion",
      "figma",
      "jira",
      "atlassian",
      "confluence",
      "trello",
      "asana",
      "monday.com",
      "clickup",
      "linear.app",
      "basecamp",
      "airtable",
      "quickbooks",
      "freshbooks",
      "xero",
      "wave accounting",
      "bench accounting",
      "mailchimp",
      "sendgrid",
      "hubspot",
      "salesforce",
      "zendesk",
      "intercom",
      "squarespace",
      "shopify",
      "wix",
      "webflow",
      "godaddy",
      "namecheap",
      "cloudflare",
      "twilio",
      "stripe",
      "plaid",
      "docusign",
      "hellosign",
      "adobe acrobat",
      "adobe creative",
      "adobe sign",
      "canva",
      "loom",
      "calendly",
      "doodle",
      "1password",
      "lastpass",
      "dashlane",
      "gusto",
      "rippling",
      "deel",
      "remote.com",
      "bamboohr",
      "workday",
      "greenhouse",
      "lever.co",
      "dropbox business",
      "box.com",
    ],
    confidence: 0.85,
  },

  // Housing
  {
    category: "housing",
    keywords: [
      "rent",
      "mortgage",
      "hoa",
      "homeowner",
      "property tax",
      "landlord",
      "apartment",
      "realty",
      "real estate",
      "property management",
      "airbnb",
      "vrbo",
      "homeaway",
      "maintenance",
      "pest control",
      "lawn",
      "landscaping",
      "cleaning service",
      "maid",
      "home depot",
      "lowe's",
      "lowes",
      "ace hardware",
      "true value",
    ],
    confidence: 0.8,
  },

  // Utilities
  {
    category: "utilities",
    keywords: [
      "electric",
      "electricity",
      "water bill",
      "water dept",
      "water utility",
      "gas co",
      "gas company",
      "natural gas",
      "sewer",
      "utility",
      "utilities",
      "power",
      "energy",
      "pge",
      "pg&e",
      "con ed",
      "coned",
      "duke energy",
      "dominion energy",
      "southern company",
      "eversource",
      "national grid",
      "dte energy",
      "consumers energy",
      "we energies",
      "xcel energy",
      "entergy",
      "ameren",
      "peco",
      "pseg",
      "comcast",
      "xfinity",
      "spectrum",
      "cox ",
      "cox cable",
      "at&t",
      "att.com",
      "verizon",
      "t-mobile",
      "tmobile",
      "sprint",
      "boost mobile",
      "cricket wireless",
      "metro by t-mobile",
      "mint mobile",
      "visible wireless",
      "google fi",
      "internet",
      "broadband",
      "phone bill",
      "cell phone",
      "wireless bill",
      "dish network",
      "directv",
      "waste management",
      "republic services",
      "trash",
      "recycling",
    ],
    confidence: 0.85,
  },

  // Travel (before transportation/dining to catch airlines, hotels first)
  {
    category: "transportation",
    keywords: [
      "airline",
      "airways",
      "united airlines",
      "delta airlines",
      "american airlines",
      "southwest airlines",
      "jetblue",
      "alaska airlines",
      "spirit airlines",
      "frontier airlines",
      "lufthansa",
      "british airways",
      "air france",
      "emirates",
      "ryanair",
      "easyjet",
      "air canada",
      "westjet",
      "hotel",
      "marriott",
      "hilton",
      "hyatt",
      "ihg",
      "sheraton",
      "westin",
      "holiday inn",
      "best western",
      "radisson",
      "wyndham",
      "fairfield",
      "hampton inn",
      "doubletree",
      "motel 6",
      "extended stay",
      "travelodge",
      "days inn",
      "super 8",
      "comfort inn",
      "quality inn",
      "la quinta",
      "expedia",
      "booking.com",
      "hotels.com",
      "priceline",
      "kayak",
      "travelocity",
      "hotwire",
      "trivago",
      "orbitz",
      "amtrak",
      "greyhound",
      "megabus",
      "flixbus",
      "enterprise rent",
      "hertz",
      "avis",
      "budget car",
      "national car",
      "alamo",
      "thrifty car",
      "dollar rental",
      "zipcar",
      "turo",
      "gas station",
      "shell ",
      "exxon",
      "chevron",
      "bp ",
      "mobil",
      "citgo",
      "sunoco",
      "wawa",
      "speedway",
      "marathon gas",
      "casey's general",
      "kwik trip",
      "circle k",
      "7-eleven gas",
      "racetrac",
      "pilot flying j",
      "loves travel",
      "flying j",
      "fuel",
      "gasoline",
      "petrol",
      "uber",
      "lyft",
      "taxi",
      "cab ",
      "rideshare",
      "parking",
      "park & ride",
      "parkwhiz",
      "spothero",
      "toll",
      "e-zpass",
      "ezpass",
      "fastrak",
      "sunpass",
      "metro",
      "subway train",
      "bart ",
      "mta ",
      "transit",
      "bus pass",
      "train ticket",
      "car wash",
      "auto parts",
      "autozone",
      "o'reilly auto",
      "advance auto",
      "napa auto",
      "pep boys",
      "jiffy lube",
      "jiffy",
      "oil change",
      "valvoline",
      "tire",
      "firestone",
      "goodyear tire",
      "discount tire",
      "americas tire",
      "mavis discount",
      "midas",
      "meineke",
      "big o tire",
      "ntb tire",
      "christian brothers auto",
      "aamco",
      "auto repair",
      "brake",
      "mechanic",
      "dealership",
      "dmv",
      "motor vehicle",
      "vehicle registration",
    ],
    confidence: 0.8,
  },

  // Groceries
  {
    category: "groceries",
    keywords: [
      "whole foods",
      "trader joe",
      "trader joes",
      "kroger",
      "ralphs",
      "fry's food",
      "smith's food",
      "king soopers",
      "fred meyer",
      "qfc ",
      "harris teeter",
      "safeway",
      "publix",
      "aldi",
      "lidl",
      "costco",
      "sam's club",
      "sams club",
      "bj's wholesale",
      "bjs wholesale",
      "walmart supercenter",
      "walmart grocery",
      "grocery",
      "supermarket",
      "market basket",
      "food lion",
      "wegmans",
      "sprouts",
      "fresh market",
      "fresh thyme",
      "natural grocers",
      "h-e-b",
      "heb",
      "meijer",
      "giant food",
      "stop & shop",
      "stop and shop",
      "shop rite",
      "shoprite",
      "acme markets",
      "winn-dixie",
      "winndixie",
      "food 4 less",
      "food max",
      "smart & final",
      "stater bros",
      "price chopper",
      "hannaford",
      "iga supermarket",
      "piggly wiggly",
      "hy-vee",
      "jewel-osco",
      "dominick's",
      "randalls",
      "tom thumb",
      "vons",
      "pavilions",
      "albertsons",
      "lucky supermarket",
      "save mart",
      "raley's",
      "winco foods",
      "dillons",
    ],
    confidence: 0.85,
  },

  // Dining
  {
    category: "dining",
    keywords: [
      "restaurant",
      "chipotle",
      "mcdonald",
      "mcdonalds",
      "mcd ",
      "starbucks",
      "sbux",
      "dunkin",
      "dunkin donuts",
      "subway sandwich",
      "domino",
      "pizza hut",
      "papa john",
      "little caesar",
      "pizza",
      "burger king",
      "burger",
      "taco bell",
      "7-eleven",
      "7 eleven",
      "7-11",
      "wendy",
      "chick-fil-a",
      "chickfila",
      "panera",
      "grubhub",
      "doordash",
      "ubereats",
      "uber eats",
      "postmates",
      "instacart",
      "drizly",
      "seamless",
      "caviar food",
      "cafe",
      "coffee",
      "diner",
      "grill ",
      "kitchen",
      "bakery",
      "sushi",
      "thai food",
      "chinese food",
      "indian food",
      "pho",
      "ramen",
      "chili's",
      "olive garden",
      "outback steakhouse",
      "applebees",
      "tgi friday",
      "ihop",
      "waffle house",
      "denny's",
      "red lobster",
      "longhorn steakhouse",
      "texas roadhouse",
      "five guys",
      "shake shack",
      "in-n-out",
      "in n out",
      "whataburger",
      "sonic drive",
      "jack in the box",
      "del taco",
      "qdoba",
      "popeyes",
      "church's chicken",
      "kfc ",
      "kentucky fried",
      "raising cane",
      "zaxby",
      "wingstop",
      "buffalo wild",
      "jersey mike",
      "jimmy john",
      "firehouse sub",
      "potbelly",
      "jason's deli",
      "which wich",
      "moe's southwest",
      "habit burger",
      "toast tab",
      "toasttab",
      "olo.com",
      "eat ",
      "snack",
      "bar & grill",
      "pub ",
      "tavern",
      "bistro",
      "brasserie",
      "trattoria",
      "cantina",
      "taproom",
      "brew pub",
      "bbq",
      "barbeque",
      "steakhouse",
      "seafood",
      "wings",
      "noodle",
      "taqueria",
      "burrito",
      "wrap",
      "smoothie",
      "juice bar",
      "boba",
      "donut",
      "bagel",
      "deli",
      "sandwich",
      "sub shop",
      "catering",
    ],
    confidence: 0.8,
  },

  // Health & Medical
  {
    category: "health",
    keywords: [
      "pharmacy",
      "cvs",
      "walgreens",
      "rite aid",
      "riteaid",
      "duane reade",
      "health mart",
      "medicine shoppe",
      "doctor",
      "physician",
      "medical",
      "hospital",
      "dental",
      "dentist",
      "orthodont",
      "optometry",
      "optometrist",
      "vision care",
      "lenscrafters",
      "america's best",
      "visionworks",
      "urgent care",
      "clinic",
      "labcorp",
      "lab corp",
      "quest diagnostics",
      "questdiagnostics",
      "planned parenthood",
      "therapy",
      "therapist",
      "counseling",
      "psychiatry",
      "psychology",
      "mental health",
      "talkspace",
      "betterhelp",
      "cerebral health",
      "noom",
      "weight watcher",
      "nutrisystem",
      "gym",
      "fitness",
      "planet fitness",
      "la fitness",
      "24 hour fitness",
      "lifetime fitness",
      "anytime fitness",
      "equinox",
      "crunch fitness",
      "blink fitness",
      "blink gym",
      "blink ",
      "ymca",
      "crossfit",
      "orangetheory",
      "pure barre",
      "soulcycle",
      "peloton",
      "pilates",
      "yoga",
      "massage",
      "chiropractor",
      "physical therapy",
      "rehabilitation",
      "lab work",
      "blood test",
      "x-ray",
      "radiology",
      "surgery",
      "anesthesia",
      "copay",
      "co-pay",
      "prescription",
      "rx",
      "vitamin",
      "supplement",
      "gnc",
      "vitamin shoppe",
      "natural health",
      "health food",
      "healthcare",
    ],
    confidence: 0.8,
  },

  // Online education subscriptions
  {
    category: "subscriptions",
    keywords: [
      "coursera",
      "udemy",
      "skillshare",
      "linkedin learning",
      "pluralsight",
      "datacamp",
      "codecademy",
      "treehouse",
      "udacity",
      "khan academy",
      "chegg",
      "course hero",
      "quizlet",
      "masterclass",
      "brilliant.org",
      "duolingo",
    ],
    confidence: 0.82,
  },
  // Physical education / institution expenses
  {
    category: "shopping",
    keywords: [
      "tuition",
      "university",
      "college",
      "school fees",
      "textbook",
      "bookstore",
      "student fee",
      "enrollment fee",
      "campus",
    ],
    confidence: 0.72,
  },

  // Childcare / family services
  {
    category: "shopping",
    keywords: [
      "daycare",
      "day care",
      "childcare",
      "child care",
      "babysitter",
      "nanny",
      "au pair",
      "preschool",
      "nursery school",
      "after school",
      "summer camp",
      "bright horizons",
      "kindercare",
      "learning care",
    ],
    confidence: 0.78,
  },

  // Charity / donations
  {
    category: "shopping",
    keywords: [
      "donation",
      "donate",
      "charity",
      "charitable",
      "nonprofit",
      "non-profit",
      "gofundme",
      "patreon",
      "united way",
      "red cross",
      "salvation army",
      "goodwill",
      "habitat for humanity",
      "oxfam",
      "doctors without borders",
      "msf usa",
      "unicef",
      "planned parenthood",
      "aclu",
    ],
    confidence: 0.68,
  },

  // Fees
  {
    category: "fees",
    keywords: [
      "fee",
      "overdraft",
      "nsf",
      "non-sufficient",
      "insufficient fund",
      "late charge",
      "late fee",
      "service charge",
      "annual fee",
      "maintenance fee",
      "monthly fee",
      "account fee",
      "atm fee",
      "wire fee",
      "foreign transaction",
      "currency conversion",
      "cash advance fee",
      "returned check",
      "stop payment",
      "penalty",
      "fine ",
      "bank charge",
    ],
    confidence: 0.9,
  },

  // Entertainment
  {
    category: "entertainment",
    keywords: [
      "theatre",
      "theater",
      "amc ",
      "regal cinema",
      "cinemark",
      "concert",
      "ticketmaster",
      "stubhub",
      "seatgeek",
      "vivid seats",
      "eventbrite",
      "bowling",
      "arcade",
      "museum",
      "zoo ",
      "aquarium",
      "amusement park",
      "six flags",
      "cedar point",
      "universal studios",
      "disney world",
      "disneyland",
      "seaworld",
      "steam game",
      "steam purchase",
      "playstation store",
      "psn ",
      "xbox store",
      "nintendo eshop",
      "epic games",
      "riot games",
      "blizzard",
      "activision",
      "ea sports",
      "ubisoft",
      "2k games",
      "humble bundle",
      "twitch ",
      "golf",
      "mini golf",
      "go-kart",
      "escape room",
      "laser tag",
      "trampoline",
      "paintball",
      "rock climbing",
      "comedy club",
      "improv",
      "nightclub",
      "club cover",
      "bar tab",
      "karaoke",
      "billiards",
      "pool hall",
    ],
    confidence: 0.75,
  },

  // Shopping (broad — keep near end so specific merchants match first)
  {
    category: "shopping",
    keywords: [
      "amazon",
      "amzn",
      "walmart ",
      "best buy",
      "ikea",
      "etsy",
      "ebay",
      "apple store",
      "apple.com",
      "nike",
      "adidas",
      "nordstrom",
      "macy",
      "tj maxx",
      "tjmaxx",
      "marshalls",
      "ross stores",
      "old navy",
      "gap ",
      "banana republic",
      "zara",
      "h&m",
      "uniqlo",
      "forever 21",
      "express clothing",
      "victoria's secret",
      "bath & body",
      "bed bath",
      "williams sonoma",
      "pottery barn",
      "west elm",
      "restoration hardware",
      "pier 1",
      "tuesday morning",
      "five below",
      "dollar tree",
      "dollar general",
      "family dollar",
      "big lots",
      "kohls",
      "jcpenney",
      "sears",
      "jcp",
      "newegg",
      "b&h photo",
      "bhphotovideo",
      "micro center",
      "fry's electronics",
      "staples",
      "office depot",
      "officemax",
      "container store",
      "world market",
      "crate & barrel",
      "target ",
      "petco",
      "petsmart",
      "chewy",
      "petco",
      "tractor supply",
      "cabela",
      "bass pro",
      "rei ",
      "dick's sporting",
      "academy sports",
      "modell's",
      "sport chalet",
      "foot locker",
      "finish line",
      "journeys",
      "dsw ",
      "payless",
      "shoe carnival",
      "famous footwear",
      "skechers",
      "ugg ",
      "lululemon",
      "athleta",
      "under armour",
      "columbia sportswear",
      "the north face",
      "patagonia",
      "michaels store",
      "hobby lobby",
      "joann fabric",
      "craft",
      "thrift",
      "shop.com",
      "overstock",
      "wayfair",
      "wish.com",
      "temu",
      "shein",
      "aliexpress",
      "alibaba",
      "romwe",
      "zaful",
      "fashion nova",
      "pretty little thing",
      "boohoo",
      "revolve",
      "asos",
      "urban outfitters",
      "anthropologie",
      "free people",
      "depop",
      "poshmark",
      "mercari",
      "thredup",
      "costco.com",
      "samsclub",
      "sam's club",
      "bjs wholesale",
      "storenvy",
    ],
    confidence: 0.7,
  },
];

/** Merchants that strongly suggest a recurring charge. */
const RECURRING_KEYWORDS = [
  "netflix",
  "spotify",
  "hulu",
  "disney",
  "hbo",
  "max.com",
  "paramount",
  "peacock",
  "peacocktv",
  "audible",
  "apple music",
  "apple tv",
  "apple one",
  "youtube premium",
  "amazon prime",
  "amazon music",
  "siriusxm",
  "pandora",
  "tidal",
  "adobe",
  "microsoft 365",
  "office 365",
  "icloud",
  "google one",
  "google storage",
  "dropbox",
  "github",
  "gitlab",
  "slack",
  "zoom",
  "notion",
  "figma",
  "mailchimp",
  "hubspot",
  "quickbooks",
  "freshbooks",
  "shopify",
  "squarespace",
  "insurance",
  "geico",
  "state farm",
  "allstate",
  "progressive",
  "rent",
  "mortgage",
  "gym",
  "planet fitness",
  "la fitness",
  "24 hour fitness",
  "anytime fitness",
  "equinox",
  "orangetheory",
  "peloton",
  "ymca",
  "subscription",
  "monthly",
  "annual fee",
  "patreon",
  "substack",
  "crunchyroll",
  "discovery+",
  "espn+",
  "fubo",
  "sling tv",
  "masterclass",
  "sallie mae",
  "navient",
  "navient",
  "comcast",
  "xfinity",
  "spectrum",
  "at&t",
  "verizon",
  "t-mobile",
];

const NON_EXPENSE_CATEGORIES: ReadonlySet<string> = new Set(["transfers", "income", "other"]);

const EXPENSE_CATEGORIES: ReadonlySet<string> = new Set(
  CATEGORY_RULES.map((r) => r.category).filter((c) => !NON_EXPENSE_CATEGORIES.has(c)),
);

/**
 * Pass 2 — Refund detection keywords.
 * "return credit" is used rather than bare "return" to reduce false positives
 * from descriptions like "RETURN VONS 04/15" which are store returns not
 * account credits (those are caught by the refund keyword separately).
 */
const REFUND_KEYWORDS = [
  "refund",
  "return credit",
  "credit adj",
  "reversal",
  "chargeback",
  "adjustment cr",
];

/**
 * Pass 3 — Income detection keywords.
 * Only applied when the amount is non-negative. Seeing these in a description
 * strongly implies the transaction is intentional income, not just a positive
 * balance adjustment.
 */
const INCOME_KEYWORDS = [
  "deposit",
  "payment received",
  "direct dep",
  "ach credit",
  "wire from",
  "invoice",
];

/**
 * Pass 9 — Recurring income keywords.
 * These appear verbatim in bank descriptions and are definitively recurring.
 * Checked separately from INCOME_KEYWORDS because they also set recurrenceType.
 */
const RECURRING_INCOME_KEYWORDS = [
  "salary",
  "payroll",
  "direct deposit",
  "regular income",
  "benefit",
  "benefits",
  "pension",
  "social security",
  "veteran affairs",
  "dept. of veterans",
  "department of veteran",
  "thrift savings",
];

/**
 * Classify a single transaction using the v1 12-pass state machine.
 *
 * Takes the raw bank description and a signed amount (negative = outflow).
 * Internally derives flowType, merchant name, and all classification fields.
 * The caller no longer needs to pre-compute merchant or flowType.
 *
 * Pass order (from v1 spec):
 *  1  Transfer detection
 *  2  Refund detection
 *  3  Income detection (amount >= 0 only)
 *  4  Standalone "credit" keyword
 *  5  Transfer direction refinement
 *  6  Merchant rule matching (can override passes 1–5)
 *  7  Category keyword fallback (implicit — Pass 6 covers both)
 *  8  Recurring subscription heuristic
 *  9  Recurring income detection
 * 10  Transfer reclassification (residual transfers → income or expense)
 * 11  Income category lock
 * 12  aiAssisted flag assignment
 */
export function classifyTransaction(
  rawDescription: string,
  amount: number,
): ClassificationResult {
  const lower = rawDescription.toLowerCase().trim();
  const directionHint = getDirectionHint(rawDescription);
  const cleanedMerchant = normalizeMerchant(rawDescription);

  // ─── Initial defaults ──────────────────────────────────────────────────────
  // Positive amounts default to income; negative to expense.
  // Everything starts as one-time until a rule says otherwise.
  let transactionClass: ClassificationResult["transactionClass"] =
    amount >= 0 ? "income" : "expense";
  let flowType: "inflow" | "outflow" = amount >= 0 ? "inflow" : "outflow";
  let recurrenceType: "recurring" | "one-time" = "one-time";
  let category: V1Category = amount >= 0 ? "income" : "other";
  let labelReason = "Initial amount-sign heuristic";
  let matchedRule = false;
  let matchedKeyword = "";
  let labelConfidence = 0.92;

  // ─── Pass 1: Transfer detection ───────────────────────────────────────────
  // Runs first because misclassifying a transfer as income or expense skews
  // every cashflow metric. The broader check here catches all transfer-like
  // language; merchant rules (Pass 6) can then override where a specific
  // expense category applies (e.g. "TRANSFER TO AUTO LOAN" → debt).
  if (TRANSFER_KEYWORDS.some((kw) => lower.includes(kw))) {
    transactionClass = "transfer";
    category = "transfers";
  }

  // ─── Pass 2: Refund detection ─────────────────────────────────────────────
  // Only runs if not already classified as transfer.
  // A transfer cannot also be a refund.
  if (
    transactionClass !== "transfer" &&
    REFUND_KEYWORDS.some((kw) => lower.includes(kw))
  ) {
    transactionClass = "refund";
  }

  // ─── Pass 3: Income detection ─────────────────────────────────────────────
  // Only runs for non-negative amounts that are not yet transfer/refund.
  // The amount guard prevents "FEE REVERSAL DEPOSIT" with a negative amount
  // from being incorrectly promoted to income.
  if (
    transactionClass !== "transfer" &&
    transactionClass !== "refund" &&
    amount >= 0 &&
    INCOME_KEYWORDS.some((kw) => lower.includes(kw))
  ) {
    transactionClass = "income";
    category = "income";
  }

  // ─── Pass 3b: Direction hint correction ───────────────────────────────────
  // Some banks record all transactions as positive amounts (unsigned format).
  // When the description contains a strong outflow signal such as "Debit-dc",
  // "POS PURCHASE", or "ACH DEBIT", the default income classification (from the
  // positive amount) is clearly wrong.  Flip to expense here so downstream
  // passes start from the right baseline.  Only fires for the pure positive-
  // amount-default case (income from initial heuristic, not a pass-1 transfer
  // or pass-2/3 refund/income that was intentionally set by keyword).
  if (
    transactionClass === "income" &&
    amount >= 0 &&
    directionHint === "outflow"
  ) {
    transactionClass = "expense";
    flowType = "outflow";
    category = "other";
    labelReason = "Direction-hint correction (strong outflow keyword in description)";
  }

  // ─── Pass 4: Standalone "credit" keyword ──────────────────────────────────
  // Handles bank entries like "ANNUAL FEE CREDIT" or "CREDIT MEMO" that
  // represent one-time account credits, not income. The word-boundary regex
  // prevents "credit card" from triggering this — "credit" must stand alone.
  // The !hasIncomeContext guard prevents "ACH CREDIT DIRECT DEPOSIT PAYROLL"
  // from being downgraded from income to refund.
  const hasIncomeContext = INCOME_KEYWORDS.some((kw) => lower.includes(kw));
  if (
    /(^|\s)credit($|\s)/.test(lower) &&
    amount > 0 &&
    !hasIncomeContext &&
    transactionClass !== "income"
  ) {
    transactionClass = "refund";
  }

  // ─── Pass 5: Transfer direction refinement ────────────────────────────────
  // Transfers detected in Pass 1 need their flowType set for display purposes.
  // "TRANSFER TO SAVINGS" should show as outflow, "TRANSFER FROM CHECKING" as inflow.
  if (transactionClass === "transfer" && directionHint) {
    flowType = directionHint;
  }

  // ─── Pass 6: Merchant rule matching ───────────────────────────────────────
  // The largest and most important pass. Each matching rule can override:
  //   • category (always)
  //   • transactionClass (if rule.transactionClass is set, or if the category
  //     is in EXPENSE_CATEGORIES — which auto-locks to "expense")
  //   • recurrenceType (if rule.recurrenceType is set)
  //
  // This pass CAN override the transfer/refund set in passes 1–2, which is
  // intentional: "TRANSFER TO AUTO LOAN" correctly becomes debt/expense here.
  //
  // Rules are ordered specific-to-general; first match wins.
  // The "transfers" category rule is skipped — Pass 1 handles it.
  for (const rule of CATEGORY_RULES) {
    if (rule.category === "transfers") continue;
    for (const kw of rule.keywords) {
      if (lower.includes(kw)) {
        category = rule.category;
        matchedKeyword = kw;
        matchedRule = true;
        labelConfidence = rule.confidence;
        labelReason = `Matched rule keyword "${kw}" → ${category}`;

        // Determine transactionClass from the rule's explicit override.
        // If the rule has no explicit transactionClass but the category is a
        // known expense category AND the current class is still "income" (the
        // amount-sign default for positive amounts), auto-lock to "expense".
        // This corrects banks that show all amounts as positive.
        //
        // IMPORTANT: We do NOT auto-lock if transactionClass is already
        // "refund" or "transfer" — those are set by earlier passes and must
        // not be silently overridden by a merchant category match.
        if (rule.transactionClass) {
          transactionClass = rule.transactionClass;
        } else if (
          EXPENSE_CATEGORIES.has(rule.category) &&
          transactionClass === "income"
        ) {
          transactionClass = "expense";
        }

        // Keep flowType consistent with the resolved class.
        if (transactionClass === "expense") {
          flowType = "outflow";
        } else if (transactionClass === "income") {
          flowType = "inflow";
        }
        // "refund" flowType stays as-is — it may be inflow (a credit) or
        // outflow depending on the bank; we don't force it here.

        if (rule.recurrenceType) {
          recurrenceType = rule.recurrenceType;
        }
        break;
      }
    }
    if (matchedRule) break;
  }

  // ─── Pass 8: Recurring subscription heuristic ─────────────────────────────
  // If the description literally says "subscription", "monthly", "recurring",
  // or "membership" and no rule already set recurrenceType, flag it recurring.
  if (
    recurrenceType === "one-time" &&
    transactionClass !== "transfer" &&
    transactionClass !== "refund"
  ) {
    if (
      lower.includes("subscription") ||
      lower.includes("monthly") ||
      lower.includes("recurring") ||
      lower.includes("membership")
    ) {
      recurrenceType = "recurring";
    }
  }

  // ─── Pass 9: Recurring income detection ───────────────────────────────────
  // Payroll and government benefits keywords → always recurring income.
  if (recurrenceType === "one-time" && transactionClass === "income") {
    if (RECURRING_INCOME_KEYWORDS.some((kw) => lower.includes(kw))) {
      recurrenceType = "recurring";
    }
  }

  // ─── Pass 8b: Legacy RECURRING_KEYWORDS for known merchant patterns ────────
  // Keeps backward-compatible recurrence detection for merchants not captured
  // by the category-level recurrenceType or the description-keyword heuristic.
  if (
    recurrenceType === "one-time" &&
    transactionClass !== "transfer" &&
    transactionClass !== "refund"
  ) {
    if (RECURRING_KEYWORDS.some((kw) => lower.includes(kw))) {
      recurrenceType = "recurring";
    }
  }

  // ─── Pass 10: Transfer reclassification — INTENTIONALLY SKIPPED ──────────
  // The v1 spec reclassifies residual transfers to income/expense. We retain
  // "transfer" as a first-class transactionClass because our UI exposes a
  // transfers category filter in the ledger. Reclassifying would remove all
  // transfers from that view and confuse users who upload both account sides.

  // ─── Pass 11: Income category lock ────────────────────────────────────────
  // After all passes, income must have category "income". Prevents edge cases
  // where a merchant rule set a non-income category on a positive-amount row
  // that was not overridden back to expense.
  if (transactionClass === "income") {
    category = "income";
    flowType = "inflow";
  }

  // ─── Pass 12: aiAssisted flag ─────────────────────────────────────────────
  // All three conditions together mean "the rule system had nothing specific
  // to say about this transaction". The LLM enrichment layer should review it.
  //
  // Condition 1: No merchant rule matched  (matchedRule)
  // Condition 2: No recurring signal found (default stayed one-time)
  // Condition 3: No strong directional language in the description
  //
  // Transfers and refunds caught by passes 1–2 are NOT flagged — the rule
  // system DID make a specific determination for them.
  const aiAssisted =
    !matchedRule &&
    recurrenceType === "one-time" &&
    !directionHint &&
    transactionClass !== "transfer" &&
    transactionClass !== "refund";

  if (!matchedRule) {
    labelConfidence = aiAssisted ? 0.55 : 0.75;
    labelReason = aiAssisted
      ? "No strong merchant or recurrence rule matched"
      : `Amount-sign heuristic → ${category}`;
  }

  return {
    transactionClass,
    flowType,
    category,
    recurrenceType,
    merchant: cleanedMerchant,
    labelSource: "rule",
    labelConfidence,
    labelReason,
    aiAssisted,
  };
}

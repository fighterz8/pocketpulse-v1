/**
 * Drift-prevention tests for the AI classifier system prompt.
 *
 * These tests ensure that every category name referenced in the SYSTEM_PROMPT
 * is a valid member of V1_CATEGORIES.  If a prompt edit accidentally introduces
 * a category name that doesn't exist in the schema (e.g. "business_software",
 * "subscriptions", "transportation", "health"), these tests will fail loudly
 * rather than silently coercing AI output to "other" at runtime.
 */
import { describe, it, expect } from "vitest";
import { V1_CATEGORIES } from "../shared/schema.js";
import { _AI_SYSTEM_PROMPT } from "./ai-classifier.js";

const VALID_TRANSACTION_CLASSES = new Set(["income", "expense", "transfer", "refund"]);

/**
 * Extract category names from the "Category definitions" block of the prompt.
 * Each definition line looks like:  "- categoryname: description text"
 * We match lines that start with "- " followed by a lowercase identifier
 * (letters or underscores) and a colon.
 */
function extractDefinedCategories(prompt: string): string[] {
  const lines = prompt.split("\n");
  const categoryLine = /^- ([a-z_]+): /;
  const found: string[] = [];

  let inDefinitionsBlock = false;
  for (const line of lines) {
    if (/^Category definitions/i.test(line)) {
      inDefinitionsBlock = true;
      continue;
    }
    // Exit the definitions block when we reach the next section header
    if (inDefinitionsBlock && /^For each transaction/i.test(line.trim())) {
      break;
    }
    if (inDefinitionsBlock) {
      const m = categoryLine.exec(line);
      if (m) {
        found.push(m[1]!);
      }
    }
  }
  return found;
}

/**
 * Extract ALL category-like token references from the entire prompt string.
 * Looks for patterns that unambiguously set a category value:
 *   - category="foo" or category='foo'
 *   - use "foo" / Use "foo" (case-insensitive)
 *   - prefer "foo" / Prefer "foo" (case-insensitive)
 *   - category-like token anywhere in quoted assignment context
 *
 * This is case-insensitive so it catches all capitalisation variants.
 */
function extractAllCategoryReferences(prompt: string): string[] {
  const found: string[] = [];

  // 1. category="foo" or category='foo'  (anywhere in the prompt)
  const quotedEq = /category=["']([a-z_]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = quotedEq.exec(prompt)) !== null) {
    found.push(m[1]!.toLowerCase());
  }

  // 2. use "foo" for ...  — case-insensitive
  const usePattern = /\buse\s+"([a-z_]+)"/gi;
  while ((m = usePattern.exec(prompt)) !== null) {
    found.push(m[1]!.toLowerCase());
  }

  // 3. prefer "foo" over ...  — case-insensitive
  const preferPattern = /\bprefer\s+"([a-z_]+)"/gi;
  while ((m = preferPattern.exec(prompt)) !== null) {
    found.push(m[1]!.toLowerCase());
  }

  return [...new Set(found)];
}

describe("AI classifier SYSTEM_PROMPT drift prevention", () => {
  const prompt = _AI_SYSTEM_PROMPT;

  it("prompt is a non-empty string", () => {
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("every category in the definitions block is a valid V1_CATEGORY", () => {
    const defined = extractDefinedCategories(prompt);

    expect(defined.length).toBeGreaterThan(0);

    for (const cat of defined) {
      expect(
        (V1_CATEGORIES as readonly string[]).includes(cat),
        `"${cat}" appears in Category definitions but is not in V1_CATEGORIES`
      ).toBe(true);
    }
  });

  it("every category referenced anywhere in the prompt is valid (case-insensitive)", () => {
    const allRefs = extractAllCategoryReferences(prompt);

    for (const cat of allRefs) {
      const isValidCategory = (V1_CATEGORIES as readonly string[]).includes(cat);
      const isValidClass = VALID_TRANSACTION_CLASSES.has(cat);
      expect(
        isValidCategory || isValidClass,
        `"${cat}" appears as a category reference but is neither a V1_CATEGORY nor a valid transactionClass`
      ).toBe(true);
    }
  });

  it("does not mention known bad category names from the old prompt", () => {
    const knownBadCategories = [
      "business_software",
      "subscriptions",
      "transportation",
      "health",
    ];

    const allRefs = new Set(extractAllCategoryReferences(prompt));
    for (const bad of knownBadCategories) {
      expect(
        allRefs.has(bad),
        `"${bad}" must not appear as a category reference — it is not in V1_CATEGORIES`
      ).toBe(false);
    }
  });

  it("all V1_CATEGORIES have a definition in the prompt", () => {
    const defined = new Set(extractDefinedCategories(prompt));

    for (const cat of V1_CATEGORIES) {
      expect(
        defined.has(cat),
        `V1_CATEGORY "${cat}" has no definition in the Category definitions block of SYSTEM_PROMPT`
      ).toBe(true);
    }
  });

  it("the allowed-category list in the prompt is derived from V1_CATEGORIES (no extra or missing entries)", () => {
    // Extract the inline list block: lines matching "- categoryname" in the
    // "Use ONLY the following categories" section.
    const lines = prompt.split("\n");
    const listItems: string[] = [];
    let inList = false;
    for (const line of lines) {
      if (/Use ONLY the following categories/i.test(line)) {
        inList = true;
        continue;
      }
      if (inList && line.trim() === "") {
        // blank line ends the list
        if (listItems.length > 0) break;
        continue;
      }
      if (inList) {
        const m = /^- ([a-z_]+)$/.exec(line.trim());
        if (m) listItems.push(m[1]!);
        else if (listItems.length > 0) break; // non-bullet after items = end of list
      }
    }

    expect(listItems.length).toBeGreaterThan(0);
    expect(new Set(listItems)).toEqual(new Set(V1_CATEGORIES));
  });
});

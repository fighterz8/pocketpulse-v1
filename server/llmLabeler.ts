import { z } from "zod";
import {
  recurrenceTypeSchema,
  transactionCategorySchema,
  transactionClassSchema,
} from "@shared/schema";

const llmLabelSchema = z.object({
  transactionClass: transactionClassSchema,
  recurrenceType: recurrenceTypeSchema,
  category: transactionCategorySchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(240),
});

const llmResponseSchema = z.object({
  items: z.array(z.object({
    index: z.number().int().nonnegative(),
    transactionClass: transactionClassSchema,
    recurrenceType: recurrenceTypeSchema,
    category: transactionCategorySchema,
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(240),
  })),
});

interface LabelCandidate {
  rawDescription: string;
  amount: number;
  transactionClass: z.infer<typeof transactionClassSchema>;
  recurrenceType: z.infer<typeof recurrenceTypeSchema>;
  category: z.infer<typeof transactionCategorySchema>;
  aiAssisted: boolean;
}

export interface LabelDecision extends LabelCandidate {
  aiAssisted: boolean;
  labelSource: "rule" | "llm" | "manual";
  labelConfidence: string | null;
  labelReason: string | null;
}

function isLlmEnabled(): boolean {
  return process.env.LLM_LABELING_ENABLED === "true" && Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function createPrompt(candidates: LabelCandidate[]): string {
  return [
    "You label financial transactions.",
    "Only relabel ambiguous transactions.",
    "Return strict JSON with shape: {\"items\":[{\"index\":0,\"transactionClass\":\"expense|income|transfer|refund\",\"recurrenceType\":\"recurring|one-time\",\"category\":\"income|transfers|utilities|subscriptions|insurance|housing|groceries|transportation|dining|shopping|health|debt|business_software|entertainment|fees|other\",\"confidence\":0.0-1.0,\"reason\":\"short reason\"}]}",
    "Prefer deterministic categories. Use recurring only when there is a strong reason.",
    JSON.stringify(candidates.map((candidate, index) => ({
      index,
      rawDescription: candidate.rawDescription,
      amount: candidate.amount,
      currentTransactionClass: candidate.transactionClass,
      currentRecurrenceType: candidate.recurrenceType,
      currentCategory: candidate.category,
    }))),
  ].join("\n");
}

async function fetchLlmLabels(candidates: LabelCandidate[]): Promise<Map<number, z.infer<typeof llmLabelSchema>>> {
  if (process.env.ANTHROPIC_API_KEY) {
    return fetchAnthropicLabels(candidates);
  }

  return fetchOpenAiLabels(candidates);
}

async function fetchAnthropicLabels(candidates: LabelCandidate[]): Promise<Map<number, z.infer<typeof llmLabelSchema>>> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Map();
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest",
      max_tokens: 1200,
      temperature: 0,
      system: "You are a precise transaction labeling assistant. Always return valid JSON only.",
      messages: [
        {
          role: "user",
          content: createPrompt(candidates),
        },
      ],
    }),
  });

  if (!response.ok) {
    return new Map();
  }

  const payload = await response.json();
  const content = payload.content?.find((item: { type?: string }) => item.type === "text")?.text;
  if (typeof content !== "string") {
    return new Map();
  }

  try {
    const parsed = llmResponseSchema.parse(JSON.parse(content));
    return new Map(parsed.items.map((item) => [item.index, {
      transactionClass: item.transactionClass,
      recurrenceType: item.recurrenceType,
      category: item.category,
      confidence: item.confidence,
      reason: item.reason,
    }]));
  } catch {
    return new Map();
  }
}

async function fetchOpenAiLabels(candidates: LabelCandidate[]): Promise<Map<number, z.infer<typeof llmLabelSchema>>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Map();
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "You are a precise transaction labeling assistant. Always return valid JSON only.",
        },
        {
          role: "user",
          content: createPrompt(candidates),
        },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    return new Map();
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return new Map();
  }

  try {
    const parsed = llmResponseSchema.parse(JSON.parse(content));
    return new Map(parsed.items.map((item) => [item.index, {
      transactionClass: item.transactionClass,
      recurrenceType: item.recurrenceType,
      category: item.category,
      confidence: item.confidence,
      reason: item.reason,
    }]));
  } catch {
    return new Map();
  }
}

export async function maybeApplyLlmLabels<T extends LabelDecision>(candidates: T[]): Promise<T[]> {
  if (!isLlmEnabled()) {
    return candidates;
  }

  // Cadence-based recurrence detection stays deterministic and history-based.
  // This LLM path only refines ambiguous single-row labels.
  const ambiguousIndexes = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.aiAssisted);

  if (ambiguousIndexes.length === 0) {
    return candidates;
  }

  const updates = new Map<number, z.infer<typeof llmLabelSchema>>();
  for (const batch of chunk(ambiguousIndexes, 25)) {
    const labels = await fetchLlmLabels(batch.map(({ candidate }) => ({
      rawDescription: candidate.rawDescription,
      amount: candidate.amount,
      transactionClass: candidate.transactionClass,
      recurrenceType: candidate.recurrenceType,
      category: candidate.category,
      aiAssisted: candidate.aiAssisted,
    })));
    for (const [relativeIndex, label] of Array.from(labels.entries())) {
      const target = batch[relativeIndex];
      if (target) {
        updates.set(target.index, label);
      }
    }
  }

  return candidates.map((candidate, index) => {
    const label = updates.get(index);
    if (!label) {
      return candidate;
    }

    return {
      ...candidate,
      transactionClass: label.transactionClass,
      recurrenceType: label.recurrenceType,
      category: label.category,
      aiAssisted: true,
      labelSource: "llm" as const,
      labelConfidence: label.confidence.toFixed(2),
      labelReason: label.reason,
    };
  }) as T[];
}

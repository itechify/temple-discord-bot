import { readFileSync } from "node:fs";
import path from "node:path";
import { Colors, EmbedBuilder } from "discord.js";
import {
  type CardLookup,
  type ElementEmojis,
  replaceCardReferencesWithLinks,
} from "./lookup";

interface FaqRow {
  cardName: string;
  question: string;
  answer: string;
}

export interface FaqEntry {
  question: string;
  answer: string;
}

export interface FaqLookupResult {
  cardName: string;
  entries: FaqEntry[];
}

export class CardFaqLookup {
  private readonly byCardName = new Map<string, FaqLookupResult>();

  constructor(rows: FaqRow[]) {
    for (const row of rows) {
      const key = normalizeCardName(row.cardName);
      if (!key) {
        continue;
      }
      const existing = this.byCardName.get(key);
      if (!existing) {
        this.byCardName.set(key, {
          cardName: row.cardName,
          entries: [{ question: row.question, answer: row.answer }],
        });
        continue;
      }

      existing.entries.push({ question: row.question, answer: row.answer });
    }
  }

  find(query: string): FaqLookupResult | null {
    const normalized = normalizeCardName(query);
    const exact = this.byCardName.get(normalized);
    if (exact) {
      return exact;
    }

    if (!normalized || normalized.length < 3) {
      return null;
    }

    let best: FaqLookupResult | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [key, value] of this.byCardName.entries()) {
      if (normalized.length >= 4 && (key.includes(normalized) || normalized.includes(key))) {
        return value;
      }

      const distance = levenshtein(normalized, key);
      if (distance < bestDistance) {
        best = value;
        bestDistance = distance;
      }
    }

    const maxDistance = normalized.length <= 6 ? 1 : 2;
    return bestDistance <= maxDistance ? best : null;
  }
}

export function loadCardFaqLookup(): CardFaqLookup {
  const csvPath = path.resolve(__dirname, "..", "..", "faq.csv");
  const rawCsv = readFileSync(csvPath, "utf8");
  const rows = parseFaqCsv(rawCsv);
  return new CardFaqLookup(rows);
}

export function extractFaqQueries(messageContent: string): string[] {
  const regex = /\[\[\?([^[\]]+)\]\]/g;
  const matches: string[] = [];
  const seen = new Set<string>();

  for (const match of messageContent.matchAll(regex)) {
    const query = match[1]?.trim();
    if (!query) {
      continue;
    }
    const key = query.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    matches.push(query);
  }

  return matches;
}

export function buildFaqEmbeds(
  faq: FaqLookupResult,
  elementEmojis: ElementEmojis,
  cardLookup: CardLookup,
): EmbedBuilder[] {
  const maxDescriptionLength = 3900;
  const embeds: EmbedBuilder[] = [];
  let current = "";
  let page = 1;

  const pushCurrent = (): void => {
    if (!current.trim()) {
      return;
    }

    const title =
      page === 1 ? `FAQ for ${faq.cardName}` : `FAQ for ${faq.cardName} (cont. ${page})`;
    embeds.push(
      new EmbedBuilder()
        .setTitle(title)
        .setColor(Colors.LuminousVividPink)
        .setDescription(current.trim()),
    );
    current = "";
    page += 1;
  };

  for (const entry of faq.entries) {
    const question = replaceCardReferencesWithLinks(
      replaceThresholdSymbols(entry.question, elementEmojis),
      cardLookup,
    );
    const answer = replaceCardReferencesWithLinks(
      replaceThresholdSymbols(entry.answer, elementEmojis),
      cardLookup,
    );
    const block = `_${question}_\n${indentAnswer(answer)}\n\n`;
    const safeBlock =
      block.length > maxDescriptionLength
        ? `${block.slice(0, maxDescriptionLength - 4)}...\n`
        : block;

    if ((current + safeBlock).length > maxDescriptionLength) {
      pushCurrent();
    }

    current += safeBlock;
  }

  pushCurrent();

  return embeds;
}

function indentAnswer(value: string): string {
  return value
    .split("\n")
    .map((line) => (line.trim().length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

function parseFaqCsv(input: string): FaqRow[] {
  const rows = parseCsv(input);
  if (rows.length === 0) {
    return [];
  }

  const dataRows = rows.slice(1);
  const result: FaqRow[] = [];
  let currentCardName = "";

  for (const row of dataRows) {
    const [cardNameRaw, questionRaw, answerRaw] = row;
    const cardName = (cardNameRaw ?? "").trim();
    const question = (questionRaw ?? "").trim();
    const answer = (answerRaw ?? "").trim();

    if (cardName) {
      currentCardName = cardName;
    }

    if (!currentCardName || !question || !answer) {
      continue;
    }

    result.push({
      cardName: currentCardName,
      question,
      answer,
    });
  }

  return result;
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        i += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        i += 1;
      }
      row.push(value);
      value = "";
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    value += char;
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    if (row.some((cell) => cell.length > 0)) {
      rows.push(row);
    }
  }

  return rows;
}

function replaceThresholdSymbols(text: string, elementEmojis: ElementEmojis): string {
  return text.replace(/\(([AEFW])\)/g, (match, symbol: string) => {
    switch (symbol) {
      case "A":
        return elementEmojis.air;
      case "E":
        return elementEmojis.earth;
      case "F":
        return elementEmojis.fire;
      case "W":
        return elementEmojis.water;
      default:
        return match;
    }
  });
}

function normalizeCardName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) {
    prev[j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) {
      prev[j] = curr[j];
    }
  }

  return prev[b.length];
}

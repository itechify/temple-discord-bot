import { readFileSync } from "node:fs";
import path from "node:path";
import { EmbedBuilder } from "discord.js";

interface CardThresholds {
  air?: number;
  earth?: number;
  fire?: number;
  water?: number;
}

interface CardGuardian {
  rarity?: string;
  type?: string;
  rulesText?: string;
  cost?: number | null;
  attack?: number | null;
  defence?: number | null;
  life?: number | null;
  thresholds?: CardThresholds | null;
}

interface CardVariant {
  slug?: string;
  typeText?: string;
}

interface CardSet {
  variants?: CardVariant[];
}

export interface ElementEmojis {
  air: string;
  earth: string;
  fire: string;
  water: string;
}

export interface CardRecord {
  name: string;
  elements?: string | null;
  subTypes?: string | null;
  guardian: CardGuardian;
  sets?: CardSet[];
}

export interface CardLookupResult {
  card: CardRecord | null;
  query: string;
  matchedBy: "exact" | "fuzzy" | "none";
}

export class CardLookup {
  private readonly cards: CardRecord[];
  private readonly exactByName = new Map<string, CardRecord>();

  constructor(cards: CardRecord[]) {
    this.cards = cards;
    for (const card of cards) {
      this.exactByName.set(normalizeCardName(card.name), card);
    }
  }

  find(query: string): CardLookupResult {
    const normalized = normalizeCardName(query);
    const exact = this.exactByName.get(normalized);
    if (exact) {
      return { card: exact, query, matchedBy: "exact" };
    }

    const fuzzy = this.findBestFuzzy(normalized);
    if (fuzzy) {
      return { card: fuzzy, query, matchedBy: "fuzzy" };
    }

    return { card: null, query, matchedBy: "none" };
  }

  private findBestFuzzy(normalizedQuery: string): CardRecord | null {
    if (!normalizedQuery || normalizedQuery.length < 3) {
      return null;
    }

    let best: CardRecord | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const card of this.cards) {
      const normalizedName = normalizeCardName(card.name);

      if (
        normalizedQuery.length >= 4 &&
        (normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName))
      ) {
        return card;
      }

      const distance = levenshtein(normalizedQuery, normalizedName);
      if (distance < bestDistance) {
        best = card;
        bestDistance = distance;
      }
    }

    const maxDistance = normalizedQuery.length <= 6 ? 1 : 2;
    return bestDistance <= maxDistance ? best : null;
  }
}

export function loadCardLookup(): CardLookup {
  const cardsPath = path.resolve(__dirname, "..", "..", "cards.json");
  const raw = readFileSync(cardsPath, "utf8");
  const parsed = JSON.parse(raw) as CardRecord[];
  return new CardLookup(parsed);
}

export function extractCardQueries(messageContent: string): string[] {
  const regex = /\[\[([^[\]]+)\]\]/g;
  const matches: string[] = [];
  const seen = new Set<string>();

  for (const match of messageContent.matchAll(regex)) {
    const query = match[1]?.trim();
    if (!query) {
      continue;
    }
    if (query.startsWith("?")) {
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

export function buildCardEmbed(card: CardRecord, elementEmojis: ElementEmojis): EmbedBuilder {
  const guardian = card.guardian ?? {};
  const typeText = extractTypeText(card);
  const combatStats = formatCombatStats(guardian);
  const lifeStat = formatLifeStat(guardian);
  const titleResources = formatTitleResources(guardian, elementEmojis);
  const slug = extractCuriosaSlugFromCard(card);
  const cardUrl = `https://curiosa.io/cards/${slug}`;
  const headerLine = titleResources
    ? `**[${escapeLinkText(card.name)}](${cardUrl})** ${titleResources}`
    : `**[${escapeLinkText(card.name)}](${cardUrl})**`;

  const lines = [headerLine, ""];
  if (typeText) {
    lines.push(`_${boldCapitalizedWords(typeText)}_`);
  }
  if (combatStats || lifeStat !== null) {
    const statParts: string[] = [];
    if (combatStats) {
      statParts.push(`⚔️ ${combatStats}`);
    }
    if (lifeStat !== null) {
      statParts.push(`❤️ ${lifeStat}`);
    }
    lines.push(`\`${statParts.join("  |  ")}\``);
  }
  if (guardian.rulesText) {
    lines.push("");
    lines.push(replaceThresholdSymbols(guardian.rulesText, elementEmojis));
  }

  return new EmbedBuilder().setColor(rarityColor(guardian.rarity)).setDescription(lines.join("\n"));
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

function extractCuriosaSlugFromCard(card: CardRecord): string {
  const variantSlug = card.sets
    ?.flatMap((set) => set.variants ?? [])
    .map((variant) => variant.slug)
    .find((slug): slug is string => Boolean(slug));

  if (variantSlug) {
    const match = variantSlug.match(/^[^-]+-([^-]+)-/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return normalizeCardName(card.name).replace(/\s+/g, "_");
}

function extractTypeText(card: CardRecord): string {
  return (
    card.sets
      ?.flatMap((set) => set.variants ?? [])
      .map((variant) => variant.typeText?.trim())
      .find((value): value is string => Boolean(value)) ?? ""
  );
}

function boldCapitalizedWords(value: string): string {
  const skipWords = new Set(["a", "an", "the", "your", "my", "our", "their", "his", "her", "its"]);

  return value.replace(/\b[A-Z][A-Za-z']*\b/g, (word) => {
    if (skipWords.has(word.toLowerCase())) {
      return word;
    }
    return `**${word}**`;
  });
}

function escapeLinkText(value: string): string {
  return value.replace(/]/g, "\\]");
}

function formatTitleResources(guardian: CardGuardian, elementEmojis: ElementEmojis): string {
  const tokens: string[] = [];
  const cost = guardian.cost;

  if (cost !== null && cost !== undefined) {
    tokens.push(`(${cost})`);
  }

  const thresholds = guardian.thresholds;
  if (!thresholds) {
    return tokens.join(" ");
  }

  const thresholdTokens: Array<[number, string]> = [
    [thresholds.air ?? 0, elementEmojis.air],
    [thresholds.earth ?? 0, elementEmojis.earth],
    [thresholds.fire ?? 0, elementEmojis.fire],
    [thresholds.water ?? 0, elementEmojis.water],
  ];

  for (const [count, emoji] of thresholdTokens) {
    if (count > 0) {
      tokens.push(emoji.repeat(count));
    }
  }

  return tokens.join(" ");
}

function replaceThresholdSymbols(text: string, elementEmojis: ElementEmojis): string {
  return text.replace(/\(([AEFW])\)/g, (_match, symbol: string) => {
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
        return _match;
    }
  });
}

function formatCombatStats(guardian: CardGuardian): string {
  const { attack, defence } = guardian;
  const hasAttack = attack !== null && attack !== undefined;
  const hasDefence = defence !== null && defence !== undefined;

  if (!hasAttack && !hasDefence) {
    return "";
  }

  if (hasAttack && hasDefence) {
    if (attack === defence) {
      return `${attack}`;
    }
    return `${attack}/${defence}`;
  }

  if (hasAttack) {
    return `${attack}`;
  }

  return `${defence}`;
}

function formatLifeStat(guardian: CardGuardian): number | null {
  const life = guardian.life;
  const isAvatar = guardian.type?.trim().toLowerCase() === "avatar";
  if (!isAvatar || life === null || life === undefined) {
    return null;
  }

  return life;
}

function rarityColor(rarity?: string): number {
  const normalized = rarity?.trim().toLowerCase();
  switch (normalized) {
    case "ordinary":
      return 0x95a5a6; // grey
    case "uncommon":
    case "exceptional":
      return 0x3498db; // blue
    case "elite":
      return 0x9b59b6; // purple
    case "unique":
      return 0xe67e22; // orange
    default:
      return 0x1f8b4c;
  }
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

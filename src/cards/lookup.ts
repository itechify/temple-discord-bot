import { readFileSync } from "node:fs";
import path from "node:path";
import { EmbedBuilder } from "discord.js";

// Shape of https://api.sorcerytcg.com/api/cards (refresh with `pnpm run update-data`).
interface CardEngine {
  type?: string | null;
  rarity?: string | null;
  slot?: string | null;
  rules?: string | null;
  cost?: number | null;
  attack?: number | null;
  defense?: number | null;
  life?: number | null;
  air?: number | null;
  earth?: number | null;
  fire?: number | null;
  water?: number | null;
}

interface CardPrinting {
  slug?: string;
  printedAt?: string | null;
  set?: {
    name?: string | null;
  } | null;
  meta?: {
    typeline?: string | null;
  } | null;
}

export interface ElementEmojis {
  air: string;
  earth: string;
  fire: string;
  water: string;
}

export interface CardRecord {
  name: string;
  slug?: string;
  engine?: CardEngine | null;
  printings?: CardPrinting[];
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

export function replaceCardReferencesWithLinks(text: string, cardLookup: CardLookup): string {
  return text.replace(/\[\[([^[\]]+)\]\]/g, (rawMatch, rawQuery: string) => {
    const query = rawQuery.trim();
    if (!query || query.startsWith("?") || query.startsWith("!")) {
      return rawMatch;
    }

    const result = cardLookup.find(query);
    if (!result.card) {
      return rawMatch;
    }

    return `[${escapeLinkText(result.card.name)}](${buildCardUrl(result.card)})`;
  });
}

export function loadCardLookup(): CardLookup {
  const cardsPath = path.resolve(__dirname, "..", "..", "cards.json");
  const raw = readFileSync(cardsPath, "utf8");
  const parsed = JSON.parse(raw) as CardRecord[];
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed[0]?.engine) {
    throw new Error("cards.json is not in the expected format. Run `pnpm run update-data`.");
  }
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
    if (query.startsWith("?") || query.startsWith("!") || query.startsWith("$")) {
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
  const engine = card.engine ?? {};
  const typeText = extractTypeText(card);
  const combatStats = formatCombatStats(engine);
  const lifeStat = formatLifeStat(engine);
  const titleResources = formatTitleResources(engine, elementEmojis);
  const cardUrl = buildCardUrl(card);
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
  if (engine.rules) {
    lines.push("");
    lines.push(replaceThresholdSymbols(engine.rules, elementEmojis));
  }

  return (
    new EmbedBuilder()
      // Avatars have no rarity in the API; their slot ("Unique") keeps the old colour.
      .setColor(rarityColor(engine.rarity ?? engine.slot ?? undefined))
      .setDescription(lines.join("\n"))
  );
}

// curiosa.io/cards/* now redirects here.
export function buildCardUrl(card: CardRecord): string {
  const slug = card.slug || normalizeCardName(card.name).replace(/\s+/g, "_");
  return `https://sorcerytcg.com/cards/${slug}`;
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

// Promo printings often carry joke typelines ("mew to power"), so prefer the
// earliest regular set printing.
function extractTypeText(card: CardRecord): string {
  const rank = (printing: CardPrinting): [number, string] => [
    printing.set?.name === "Promo" ? 1 : 0,
    printing.printedAt ?? "",
  ];
  const ordered = [...(card.printings ?? [])].sort((a, b) => {
    const [promoA, dateA] = rank(a);
    const [promoB, dateB] = rank(b);
    return promoA - promoB || dateA.localeCompare(dateB);
  });

  return (
    ordered
      .map((printing) => printing.meta?.typeline?.trim())
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

function formatTitleResources(engine: CardEngine, elementEmojis: ElementEmojis): string {
  const tokens: string[] = [];
  const cost = engine.cost;

  if (cost !== null && cost !== undefined) {
    tokens.push(`(${cost})`);
  }

  const thresholdTokens: Array<[number, string]> = [
    [engine.air ?? 0, elementEmojis.air],
    [engine.earth ?? 0, elementEmojis.earth],
    [engine.fire ?? 0, elementEmojis.fire],
    [engine.water ?? 0, elementEmojis.water],
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

function formatCombatStats(engine: CardEngine): string {
  const { attack, defense: defence } = engine;
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

function formatLifeStat(engine: CardEngine): number | null {
  const life = engine.life;
  const isAvatar = engine.type?.trim().toLowerCase() === "avatar";
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

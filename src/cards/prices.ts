import { EmbedBuilder } from "discord.js";
import type { CardLookup } from "./lookup";
import type { Logger } from "../util/logger";

interface TcgCsvResponse<T> {
  success: boolean;
  errors?: string[];
  results: T[];
}

interface TcgCsvGroup {
  groupId: number;
  name: string;
}

interface TcgCsvProduct {
  productId: number;
  name: string;
  cleanName?: string | null;
  url?: string | null;
}

interface TcgCsvPrice {
  productId: number;
  lowPrice?: number | null;
  midPrice?: number | null;
  highPrice?: number | null;
  marketPrice?: number | null;
  subTypeName?: string | null;
}

interface PricePrint {
  setName: string;
  normal?: PriceLine;
  foil?: PriceLine;
}

interface PriceLine {
  marketPrice?: number | null;
  lowPrice?: number | null;
  midPrice?: number | null;
  tcgPlayerUrl?: string;
}

interface PriceIndexEntry {
  displayName: string;
  prints: PricePrint[];
}

export interface PriceLookupResult {
  cardName: string;
  prints: PricePrint[];
}

interface TcgCsvPriceLookupOptions {
  categoryId: number;
  cacheMinutes: number;
  maxPrints: number;
  logger: Logger;
}

export class TcgCsvPriceLookup {
  private readonly categoryId: number;
  private readonly cacheMs: number;
  private readonly maxPrints: number;
  private readonly logger: Logger;
  private readonly baseUrl = "https://tcgcsv.com/tcgplayer";
  private loadedAt = 0;
  private loadingPromise: Promise<void> | null = null;
  private byName = new Map<string, PriceIndexEntry>();

  constructor(options: TcgCsvPriceLookupOptions) {
    this.categoryId = options.categoryId;
    this.cacheMs = options.cacheMinutes * 60_000;
    this.maxPrints = options.maxPrints;
    this.logger = options.logger;
  }

  async find(query: string, cardLookup: CardLookup): Promise<PriceLookupResult | null> {
    await this.ensureLoaded();

    const card = cardLookup.find(query).card;
    const canonicalName = card?.name ?? query;
    const normalizedCanonical = normalize(canonicalName);
    const normalizedQuery = normalize(query);

    const probe = normalizedCanonical || normalizedQuery;
    const merged = this.mergeMatchingEntries(probe);
    if (merged) {
      return {
        cardName: merged.displayName,
        prints: merged.prints.slice(0, this.maxPrints),
      };
    }

    const direct =
      this.byName.get(normalizedCanonical) ??
      this.byName.get(normalizedQuery) ??
      this.findBestFuzzy(probe);
    if (!direct || direct.prints.length === 0) {
      return null;
    }

    return {
      cardName: direct.displayName,
      prints: direct.prints.slice(0, this.maxPrints),
    };
  }

  private mergeMatchingEntries(probe: string): PriceIndexEntry | null {
    if (!probe || probe.length < 4) {
      return null;
    }

    const matches: PriceIndexEntry[] = [];
    for (const [key, entry] of this.byName.entries()) {
      if (
        key === probe ||
        key.startsWith(`${probe} `) ||
        key.endsWith(` ${probe}`) ||
        key.includes(` ${probe} `) ||
        probe.startsWith(`${key} `) ||
        probe.endsWith(` ${key}`) ||
        probe.includes(` ${key} `)
      ) {
        matches.push(entry);
      }
    }

    if (matches.length === 0) {
      return null;
    }

    const bySet = new Map<string, PricePrint>();
    for (const entry of matches) {
      for (const print of entry.prints) {
        const existing = bySet.get(print.setName);
        if (!existing) {
          bySet.set(print.setName, {
            setName: print.setName,
            normal: print.normal,
            foil: print.foil,
          });
          continue;
        }

        existing.normal = existing.normal ?? print.normal;
        existing.foil = existing.foil ?? print.foil;
      }
    }

    const prints = Array.from(bySet.values()).sort((a, b) => b.setName.localeCompare(a.setName));
    if (prints.length === 0) {
      return null;
    }

    return {
      displayName: matches[0].displayName,
      prints,
    };
  }

  private async ensureLoaded(): Promise<void> {
    const isFresh = this.loadedAt > 0 && Date.now() - this.loadedAt < this.cacheMs;
    if (isFresh) {
      return;
    }

    if (!this.loadingPromise) {
      this.loadingPromise = this.refresh().finally(() => {
        this.loadingPromise = null;
      });
    }

    await this.loadingPromise;
  }

  private async refresh(): Promise<void> {
    const groupsResponse = await fetchJson<TcgCsvGroup>(
      `${this.baseUrl}/${this.categoryId}/groups`,
      this.logger,
    );
    const groups = groupsResponse.results;

    const nextByName = new Map<string, PriceIndexEntry>();
    for (const group of groups) {
      try {
        const [productsResponse, pricesResponse] = await Promise.all([
          fetchJson<TcgCsvProduct>(
            `${this.baseUrl}/${this.categoryId}/${group.groupId}/products`,
            this.logger,
          ),
          fetchJson<TcgCsvPrice>(
            `${this.baseUrl}/${this.categoryId}/${group.groupId}/prices`,
            this.logger,
          ),
        ]);

        const productById = new Map<number, TcgCsvProduct>();
        for (const product of productsResponse.results) {
          productById.set(product.productId, product);
        }

        const bestByProductId = new Map<number, { normal?: TcgCsvPrice; foil?: TcgCsvPrice }>();
        for (const price of pricesResponse.results) {
          const bucket = bestByProductId.get(price.productId) ?? {};
          const product = productById.get(price.productId);
          const priceType = classifyPriceType(
            price.subTypeName,
            product?.name ?? "",
            product?.cleanName ?? "",
            product?.url ?? "",
          );
          if (priceType === "foil") {
            if (!bucket.foil || priceScore(price) > priceScore(bucket.foil)) {
              bucket.foil = price;
            }
          } else if (!bucket.normal || priceScore(price) > priceScore(bucket.normal)) {
            bucket.normal = price;
          }
          bestByProductId.set(price.productId, bucket);
        }

        for (const product of productsResponse.results) {
          const key = normalizeProductLookupName(product.cleanName || product.name);
          if (!key) {
            continue;
          }

          const selectedPrices = bestByProductId.get(product.productId);
          const normalPrice = selectedPrices?.normal;
          const foilPrice = selectedPrices?.foil;
          const productKind = classifyPriceType(
            null,
            product.name,
            product.cleanName ?? "",
            product.url ?? "",
          );
          if (!normalPrice && !foilPrice && productKind !== "foil") {
            continue;
          }

          const print: PricePrint = {
            setName: group.name,
            normal: normalPrice
              ? {
                  marketPrice: normalPrice.marketPrice ?? null,
                  lowPrice: normalPrice.lowPrice ?? null,
                  midPrice: normalPrice.midPrice ?? null,
                  tcgPlayerUrl: product.url ?? undefined,
                }
              : undefined,
            foil: foilPrice
              ? {
                  marketPrice: foilPrice.marketPrice ?? null,
                  lowPrice: foilPrice.lowPrice ?? null,
                  midPrice: foilPrice.midPrice ?? null,
                  tcgPlayerUrl: product.url ?? undefined,
                }
              : productKind === "foil"
                ? {
                    marketPrice: null,
                    lowPrice: null,
                    midPrice: null,
                    tcgPlayerUrl: product.url ?? undefined,
                  }
                : undefined,
          };

          const existing = nextByName.get(key);
          if (!existing) {
            nextByName.set(key, {
              displayName: stripFoilDecorators(product.name),
              prints: [print],
            });
            continue;
          }

          const sameSet = existing.prints.find((item) => item.setName === print.setName);
          if (!sameSet) {
            existing.prints.push(print);
            continue;
          }

          sameSet.normal = sameSet.normal ?? print.normal;
          sameSet.foil = sameSet.foil ?? print.foil;
        }
      } catch (error) {
        this.logger.warn("Skipping TCGCSV group due to lookup failure.", {
          categoryId: this.categoryId,
          groupId: group.groupId,
          error,
        });
      }
    }

    for (const entry of nextByName.values()) {
      entry.prints.sort((a, b) => b.setName.localeCompare(a.setName));
    }

    this.byName = nextByName;
    this.loadedAt = Date.now();
    this.logger.info("Refreshed TCGCSV Sorcery price cache.", {
      categoryId: this.categoryId,
      cardCount: this.byName.size,
    });
  }

  private findBestFuzzy(normalizedQuery: string): PriceIndexEntry | null {
    if (!normalizedQuery || normalizedQuery.length < 3) {
      return null;
    }

    let best: PriceIndexEntry | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [key, value] of this.byName.entries()) {
      if (
        normalizedQuery.length >= 4 &&
        (key.includes(normalizedQuery) || normalizedQuery.includes(key))
      ) {
        return value;
      }

      const distance = levenshtein(normalizedQuery, key);
      if (distance < bestDistance) {
        best = value;
        bestDistance = distance;
      }
    }

    const maxDistance = normalizedQuery.length <= 6 ? 1 : 2;
    return bestDistance <= maxDistance ? best : null;
  }
}

export function extractPriceQueries(messageContent: string): string[] {
  const regex = /\[\[\s*\$([^[\]]+)\]\]/g;
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

export function buildPriceEmbed(result: PriceLookupResult): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Prices for ${result.cardName}`)
    .setColor(0x57f287);

  for (const print of result.prints) {
    const lines: string[] = [];
    if (print.normal) {
      const normalLabel = print.normal.tcgPlayerUrl
        ? `[Normal](${print.normal.tcgPlayerUrl})`
        : "Normal";
      lines.push(
        `${normalLabel}: ${formatPriceLine(print.normal.marketPrice, print.normal.lowPrice, print.normal.midPrice)}`,
      );
    }
    if (print.foil) {
      const foilLabel = print.foil.tcgPlayerUrl ? `[Foil](${print.foil.tcgPlayerUrl})` : "Foil";
      lines.push(
        `${foilLabel}: ${formatPriceLine(print.foil.marketPrice, print.foil.lowPrice, print.foil.midPrice)}`,
      );
    }

    embed.addFields({
      name: `${setEmoji(print.setName)} ${print.setName}`,
      value: lines.join("\n"),
      inline: true,
    });
  }

  return embed;
}

async function fetchJson<T>(url: string, logger: Logger): Promise<TcgCsvResponse<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return (await response.json()) as TcgCsvResponse<T>;
  } catch (error) {
    logger.warn("Failed TCGCSV request.", { url, error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function priceScore(value: TcgCsvPrice): number {
  const subtype = (value.subTypeName ?? "").toLowerCase();
  let score = 0;
  if (subtype.includes("normal") || subtype.includes("standard")) {
    score += 100;
  } else if (subtype.includes("non-foil") || subtype.includes("non foil")) {
    score += 80;
  }

  if (value.marketPrice !== null && value.marketPrice !== undefined) {
    score += 20;
  } else if (value.midPrice !== null && value.midPrice !== undefined) {
    score += 10;
  } else if (value.lowPrice !== null && value.lowPrice !== undefined) {
    score += 5;
  }

  return score;
}

function classifyPriceType(
  subTypeName: string | null | undefined,
  productName: string,
  cleanName: string,
  productUrl: string,
): "normal" | "foil" {
  const subtype = (subTypeName ?? "").toLowerCase();
  const label = `${productName} ${cleanName} ${productUrl}`.toLowerCase();
  if (subtype.includes("non-foil") || subtype.includes("non foil")) {
    return "normal";
  }
  if (subtype.includes("foil") || /\b(foil|holo|holographic)\b/.test(label)) {
    return "foil";
  }
  return "normal";
}

function normalizeProductLookupName(value: string): string {
  return normalize(stripFoilDecorators(value));
}

function stripFoilDecorators(value: string): string {
  return value
    .replace(/\(\s*foil\s*\)/gi, "")
    .replace(/\[\s*foil\s*\]/gi, "")
    .replace(/\bfoil\b/gi, "")
    .replace(/\bholo(graphic)?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function setEmoji(setName: string): string {
  const key = setName.toLowerCase();
  if (key.includes("alpha")) {
    return "🅰️";
  }
  if (key.includes("beta")) {
    return "🅱️";
  }
  if (key.includes("arthurian")) {
    return "🛡️";
  }
  if (key.includes("gothic")) {
    return "🕯️";
  }
  if (key.includes("dragonlord")) {
    return "🐉";
  }
  if (key.includes("draft")) {
    return "🧩";
  }
  return "📦";
}

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "N/A";
  }
  return `$${value.toFixed(2)}`;
}

function formatPriceLine(
  marketPrice: number | null | undefined,
  lowPrice: number | null | undefined,
  midPrice: number | null | undefined,
): string {
  const market = formatUsd(marketPrice);
  const low = formatUsd(lowPrice);
  const mid = formatUsd(midPrice);
  if (market === "N/A" && low === "N/A" && mid === "N/A") {
    return "N/A";
  }
  return `**${market}** (${low} / ${mid})`;
}

function normalize(value: string): string {
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

  const previous = new Array<number>(b.length + 1);
  const current = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) {
    previous[j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }

    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

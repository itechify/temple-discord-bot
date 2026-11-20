// Refreshes cards.json and faq.csv from the official Sorcery sources.
// Usage: node scripts/update-data.mjs   (or: pnpm run update-data)
//
// Cards: the public card API (https://api.sorcerytcg.com/api/cards).
// FAQs: the endpoint behind https://sorcerytcg.com/faqs. It is undocumented and may
// change; if it breaks, open that page in a browser and look for the
// "codex.listFaqs" request in the network tab.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CARDS_URL = "https://api.sorcerytcg.com/api/cards";
const FAQS_URL = "https://sorcerytcg.com/api/trpc/codex.listFaqs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "sorcery-discord-bot data refresh" },
  });
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }
  return response.json();
}

function spansToText(children) {
  return (children ?? [])
    .map((child) => {
      const text = child.text ?? "";
      if (!text.trim()) {
        return text;
      }
      const marks = child.marks ?? [];
      let result = text;
      if (marks.includes("em")) {
        result = `*${result}*`;
      }
      if (marks.includes("strong")) {
        result = `**${result}**`;
      }
      return result;
    })
    .join("");
}

function portableTextToMarkdown(blocks) {
  const lines = [];
  for (const block of blocks ?? []) {
    if (block._type === "block") {
      const text = spansToText(block.children).trim();
      if (!text) {
        continue;
      }
      lines.push(block.listItem ? `- ${text}` : text);
      continue;
    }

    if (block._type === "damageGrid") {
      // One inline-code line per row: survives the bot's italics (questions) and
      // quote prefixes (answers). Blank cells are void, shown as a dot.
      const rows = (block.grid?.rows ?? []).map((row) =>
        (row.cells ?? []).map((cell) => String(cell ?? "").trim() || "·"),
      );
      const width = Math.max(1, ...rows.flat().map((cell) => cell.length));
      for (const cells of rows) {
        lines.push(`\`${cells.map((cell) => cell.padEnd(width)).join(" ")}\``);
      }
      continue;
    }

    throw new Error(`Unknown FAQ block type: ${block._type}`);
  }
  return lines.join("\n");
}

function csvField(value) {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function main() {
  const cards = await fetchJson(CARDS_URL);
  if (!Array.isArray(cards) || cards.length === 0 || !cards[0]?.engine) {
    throw new Error("Card API returned an unexpected shape.");
  }

  const faqResponse = await fetchJson(FAQS_URL);
  const faqs = faqResponse?.result?.data?.json;
  if (!Array.isArray(faqs) || faqs.length === 0) {
    throw new Error("FAQ endpoint returned an unexpected shape.");
  }

  const nameBySlug = new Map(cards.map((card) => [card.slug, card.name]));
  const rows = [];
  const unknownSlugs = new Set();

  for (const faq of faqs) {
    const question = portableTextToMarkdown(faq.question);
    const answer = portableTextToMarkdown(faq.answer);
    if (!question || !answer) {
      continue;
    }

    for (const slug of faq.cards ?? []) {
      const cardName = nameBySlug.get(slug);
      if (!cardName) {
        unknownSlugs.add(slug);
        continue;
      }
      rows.push({ cardName, question, answer, orderRank: faq.orderRank ?? "" });
    }
  }

  if (unknownSlugs.size > 0) {
    throw new Error(
      `FAQs reference cards missing from the card API: ${[...unknownSlugs].join(", ")}`,
    );
  }

  rows.sort(
    (a, b) =>
      a.cardName.localeCompare(b.cardName, "en") || a.orderRank.localeCompare(b.orderRank, "en"),
  );

  const csvLines = ["card name,question,answer"];
  let previousCard = "";
  for (const row of rows) {
    const cardColumn = row.cardName === previousCard ? "" : row.cardName;
    previousCard = row.cardName;
    csvLines.push([cardColumn, row.question, row.answer].map(csvField).join(","));
  }

  writeFileSync(path.join(root, "cards.json"), `${JSON.stringify(cards)}\n`);
  writeFileSync(path.join(root, "faq.csv"), `${csvLines.join("\n")}\n`);

  const faqCards = new Set(rows.map((row) => row.cardName)).size;
  console.log(`cards.json: ${cards.length} cards`);
  console.log(`faq.csv: ${faqs.length} FAQs -> ${rows.length} rows across ${faqCards} cards`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

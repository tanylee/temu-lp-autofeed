import fs from "fs";
import path from "path";
import { chromium, devices } from "@playwright/test";

type Rules = Record<string, string[]>;
type CsvRow = { url: string; category?: string };
type Item = {
  id: string;
  title: string;
  price: number | null;
  image: string;
  url: string;
  category: string;
  description?: string;
  images?: string[];
};

const ROOT = path.resolve(__dirname, "..");
const CSV = path.join(ROOT, "data", "manual_products.csv");
const OUT = path.join(ROOT, "data", "products.json");
const RULES_PATH = path.join(ROOT, "config", "rules.json");

// ————— helpers —————
function readCSV(): CsvRow[] {
  const src = fs.readFileSync(CSV, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const header = src[0].toLowerCase();
  const rows: CsvRow[] = [];
  if (header.includes(",")) {
    // формат: url,category (порядок не важен)
    const cols = header.split(",").map(s => s.trim());
    const idxUrl = cols.findIndex(c => c === "url");
    const idxCat = cols.findIndex(c => c === "category");
    for (const line of src.slice(1)) {
      const parts = line.split(",");
      const url = (parts[idxUrl] || "").trim();
      const category = idxCat >= 0 ? (parts[idxCat] || "").trim() : "";
      if (url) rows.push({ url, category });
    }
  } else {
    // формат: только url
    for (const line of src) {
      if (line.startsWith("#") || line==="url") continue;
      rows.push({ url: line });
    }
  }
  return rows;
}

function loadRules(): Rules {
  if (fs.existsSync(RULES_PATH)) {
    return JSON.parse(fs.readFileSync(RULES_PATH, "utf8"));
  }
  return {};
}

function parsePriceText(t?: string): number | null {
  if (!t) return null;
  const n = Number(String(t).replace(/[^\d.]/g, ""));
  return isFinite(n) ? n : null;
}

function categorize(text: string, rules: Rules): string {
  const hay = text.toLowerCase();
  let bestCat = "Misc";
  let bestHits = 0;
  for (const [cat, keywords] of Object.entries(rules)) {
    const hits = keywords.reduce((acc, k) => acc + (hay.includes(k.toLowerCase()) ? 1 : 0), 0);
    if (hits > bestHits) { bestHits = hits; bestCat = cat; }
  }
  return bestCat;
}

async function extract(page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(()=>{});
  const finalUrl = page.url();

  const title =
    (await page.locator("h1").first().textContent().catch(()=> ""))?.trim() || "";

  const priceText =
    (await page.locator('[data-price], [class*="price"], .price').first().textContent().catch(()=> "")) || "";
  const price = parsePriceText(priceText);

  const description =
    (await page.evaluate(() =>
      (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content || ""
    ).catch(()=> "")) || "";

  const crumbs =
    (await page.locator('nav, [class*="breadcrumb"]').first().innerText().catch(()=> "")) || "";

  const image = await page.evaluate(() => {
    const pick = (sel: string) =>
      (document.querySelector(sel) as HTMLImageElement | null)?.getAttribute("src") ||
      (document.querySelector(sel) as HTMLImageElement | null)?.getAttribute("data-src") ||
      "";
    return pick('img[alt][src^="http"]') || pick('img[src^="http"]') || "";
  });

  const images: string[] =
    (await page.evaluate(() =>
      Array.from(document.querySelectorAll("img"))
        .map((i:any) => i.getAttribute("src") || i.getAttribute("data-src") || "")
        .filter(u => /^https?:\/\//.test(u))
        .slice(0, 8)
    ).catch(()=> [])) || [];

  let id = "";
  try { const u = new URL(finalUrl); id = u.searchParams.get("goods_id") || u.searchParams.get("sku_id") || ""; } catch {}
  if (!id) id = finalUrl;

  return { id, title, price, image: image || images[0] || "", description, crumbs, images };
}

// ————— main —————
async function main() {
  const rules = loadRules();
  const rows = readCSV();
  if (!rows.length) throw new Error("В data/manual_products.csv нет ссылок");

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    ...devices["Desktop Chrome"],
    locale: "en-US",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  });

  const byCat: Record<string, Item[]> = {};
  const concurrency = 8;                    // парсим пачками (8 параллельно)
  let i = 0;

  while (i < rows.length) {
    const batch = rows.slice(i, i + concurrency);
    i += concurrency;

    const results = await Promise.allSettled(
      batch.map(async (row) => {
        const page = await ctx.newPage();
        try {
          const p = await extract(page, row.url);
          if (!p.title || !p.image) throw new Error("no title/image");
          const textForRules = [p.title, p.description, p.crumbs].join(" • ");
          const autoCat = categorize(textForRules, rules);
          const category = row.category?.trim() || autoCat;

          const item: Item = {
            id: String(p.id),
            title: p.title,
            price: p.price ?? null,
            image: p.image,
            url: row.url,                  // твоя партнёрская ссылка
            category,
            description: (p.description || "").replace(/\s+/g, " ").slice(0, 200),
            images: p.images || []
          };
          return item;
        } finally {
          await page.close().catch(()=>{});
        }
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        const item = r.value as Item;
        byCat[item.category] ??= [];
        if (!byCat[item.category].some(x => x.id === item.id)) {
          byCat[item.category].push(item);
        }
      } else {
        console.warn("Skip item:", r.status === "rejected" ? r.reason : "unknown");
      }
    }
  }

  await ctx.close(); await browser.close();

  const feed = {
    generatedAt: new Date().toISOString(),
    categories: Object.entries(byCat).map(([name, items]) => ({ name, items }))
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(feed, null, 2), "utf8");
  console.log(`✅ feed saved → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });

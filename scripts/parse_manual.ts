import fs from "fs";
import path from "path";
import { chromium, devices } from "@playwright/test";

// ---------------- paths & types ----------------
type Rules = Record<string, string[]>;
type CsvRow = { url: string; category?: string };
type Item = {
  id: string;
  title: string;
  price: number | null;
  image: string;
  url: string;        // твоя партнёрская ссылка
  category: string;
  description?: string;
  images?: string[];
};

const ROOT = path.resolve(__dirname, "..");
const CSV = path.join(ROOT, "data", "manual_products.csv");
const OUT = path.join(ROOT, "data", "products.json");
const RULES_PATH = path.join(ROOT, "config", "rules.json");
const ERR = path.join(ROOT, "data", "_errors.json");

// ---------------- helpers ----------------
function readCSV(): CsvRow[] {
  const raw = fs.readFileSync(CSV, "utf8");
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // поддерживаем:
  // 1) шапка `url` + много ссылок
  // 2) шапка `url,category`
  if (/^url(,|$)/i.test(lines[0])) {
    const header = lines[0].split(",").map(s => s.trim().toLowerCase());
    const idxUrl = header.indexOf("url");
    const idxCat = header.indexOf("category");
    const rows: CsvRow[] = [];
    for (const line of lines.slice(1)) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(",");
      const url = (parts[idxUrl] || "").trim();
      const category = idxCat >= 0 ? (parts[idxCat] || "").trim() : "";
      if (url) rows.push({ url, category });
    }
    return rows;
  } else {
    // без шапки — считаем, что весь файл это просто ссылки
    return lines
      .filter(s => !s.startsWith("#"))
      .map(url => ({ url }));
  }
}

function loadRules(): Rules {
  try {
    if (fs.existsSync(RULES_PATH)) {
      return JSON.parse(fs.readFileSync(RULES_PATH, "utf8"));
    }
  } catch {}
  return {};
}

function parsePriceText(t?: string): number | null {
  if (!t) return null;
  const n = Number(String(t).replace(/[^\d.,]/g, "").replace(",", "."));
  return isFinite(n) ? n : null;
}

function categorize(text: string, rules: Rules): string {
  const hay = text.toLowerCase();
  let best = "Misc";
  let score = 0;
  for (const [cat, keys] of Object.entries(rules)) {
    const s = keys.reduce((acc, k) => acc + (hay.includes(k.toLowerCase()) ? 1 : 0), 0);
    if (s > score) { score = s; best = cat; }
  }
  return best;
}

// Разворачиваем короткий temu.to до конечного URL
async function resolveTemu(url: string): Promise<string> {
  try {
    const res = await fetch(url, { redirect: "follow" as RequestRedirect });
    // если fetch не кинул — берём финальный URL
    return res.url || url;
  } catch {
    return url;
  }
}

// Пытаемся закрыть все частые попапы Temu
async function dismissDialogs(page) {
  const selectors = [
    '#onetrust-accept-btn-handler',               // cookies
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("Continue")',
    'button:has-text("×")',
    '[class*="close"] button',
    'button[aria-label="Close"]'
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(()=>false)) {
        await el.click({ timeout: 1000 }).catch(()=>{});
      }
    } catch {}
  }
}

async function grabProduct(page) {
  // h1 / title
  const title =
    (await page.locator('h1,[data-testid*="title"]').first().textContent().catch(()=> ""))?.trim() || "";

  // price candidates
  const priceText =
    (await page.locator('[data-testid*="price"], [class*="price"], .price').first().textContent().catch(()=> "")) || "";
  const price = parsePriceText(priceText);

  // description meta
  const description =
    (await page.evaluate(() =>
      (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content || ""
    ).catch(()=> "")) || "";

  // primary image
  const primary =
    (await page.evaluate(() => {
      const pick = (el: Element | null) =>
        (el as HTMLImageElement)?.getAttribute("src") ||
        (el as HTMLImageElement)?.getAttribute("data-src") || "";
      const cands = [
        document.querySelector('img[alt][src^="http"]'),
        document.querySelector('img[src^="http"]')
      ];
      for (const c of cands) {
        const u = pick(c);
        if (u) return u;
      }
      return "";
    }).catch(()=> "")) || "";

  const images: string[] =
    (await page.evaluate(() =>
      Array.from(document.querySelectorAll("img"))
        .map((i:any) => i.getAttribute("src") || i.getAttribute("data-src") || "")
        .filter(u => /^https?:\/\//.test(u))
        .slice(0, 8)
    ).catch(()=> [])) || [];

  // id из url
  let id = "";
  try {
    const u = new URL(page.url());
    id = u.searchParams.get("goods_id") || u.searchParams.get("sku_id") || "";
  } catch {}
  if (!id) id = page.url();

  return { id, title, price, image: primary || images[0] || "", description, images };
}

// ---------------- main ----------------
async function main() {
  const rules = loadRules();
  const rows = readCSV();
  if (!rows.length) throw new Error("В data/manual_products.csv нет ссылок");

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    ...devices["Desktop Chrome"],
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  });

  const byCat: Record<string, Item[]> = {};
  const errors: any[] = [];

  // распараллелим
  const pool = 6;
  for (let i = 0; i < rows.length; i += pool) {
    const batch = rows.slice(i, i + pool);

    const res = await Promise.allSettled(batch.map(async (r) => {
      const page = await ctx.newPage();
      const partnerUrl = r.url.trim();

      try {
        const final = await resolveTemu(partnerUrl);
        // если нас унесло на download-temu.html — всё равно открываем, но будем ждать реального контента
        await page.goto(final, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(()=>{});

        await dismissDialogs(page);

        // если внезапно показали только app-страницу — пробуем кликнуть «Continue in browser»
        const appBtn = page.locator('a:has-text("Continue")').first();
        if (await appBtn.isVisible({ timeout: 1000 }).catch(()=>false)) {
          await appBtn.click().catch(()=>{});
          await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(()=>{});
          await dismissDialogs(page);
        }

        // ждём наличия чего-то похожего на карточку
        await page.waitForSelector('h1,[data-testid*="title"], img[src^="http"]', { timeout: 12000 }).catch(()=>{});

        const p = await grabProduct(page);
        if (!p.title || !p.image) throw new Error("no title/image");

        const text = [p.title, p.description].join(" • ");
        const cat = r.category?.trim() || categorize(text, rules);

        const item: Item = {
          id: String(p.id),
          title: p.title,
          price: p.price,
          image: p.image,
          url: partnerUrl,         // сохраняем твою партнёрскую ссылку
          category: cat,
          description: (p.description || "").replace(/\s+/g, " ").slice(0, 200),
          images: p.images
        };

        byCat[item.category] ??= [];
        if (!byCat[item.category].some(x => x.id === item.id)) {
          byCat[item.category].push(item);
        }
      } catch (e: any) {
        errors.push({ url: partnerUrl, error: String(e?.message || e) });
      } finally {
        await page.close().catch(()=>{});
      }
    }));

    // подсказка в лог
    const ok = res.filter(x => x.status === "fulfilled").length;
    const fail = res.length - ok;
    console.log(`batch done: ok=${ok} fail=${fail}`);
  }

  await ctx.close(); await browser.close();

  const feed = {
    generatedAt: new Date().toISOString(),
    categories: Object.entries(byCat).map(([name, items]) => ({ name, items }))
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(feed, null, 2), "utf8");
  console.log(`✅ feed saved → ${OUT}`);

  // сохраним отчёт по ошибкам, если были
  if (errors.length) {
    fs.writeFileSync(ERR, JSON.stringify({ count: errors.length, errors }, null, 2), "utf8");
    console.warn(`⚠️ some items failed (${errors.length}). See ${ERR}`);
  } else if (fs.existsSync(ERR)) {
    fs.unlinkSync(ERR);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

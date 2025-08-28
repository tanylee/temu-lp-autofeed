// scripts/parse_manual.ts
import fs from "fs";
import path from "path";
import { chromium, Browser, Page } from "playwright";
import { parse } from "csv-parse/sync";

// ---- настройки ----
const CSV = "data/manual_products.csv";      // твой список ссылок
const OUT = "data/products.json";            // финальный фид
const MAX_ITEMS = 200;                       // ограничитель, если надо

// Десктопный UA, чтобы Temu не уводил в "Install app"
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type FeedItem = {
  product_id: string;
  title: string;
  price: number | string;
  main_image: string;
  images: string[];
  url: string;        // = view_url
  link_out: string;   // твоя партнёрка
  in_stock: boolean;
  last_seen: string;
  category?: string;
};

function ensureDir(p: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

// Пытаемся вытащить goods_id из любого URL
function extractGoodsId(u: string): string | null {
  try {
    const url = new URL(u);

    // 1) goods.html?goods_id=...
    const gid = url.searchParams.get("goods_id");
    if (gid) return gid;

    // 2) SEO-формат ...-p-<goods_id>.html
    const m = url.pathname.match(/-p-(\d+)\.html$/);
    if (m) return m[1];

    // 3) Если это download-temu.html?target_url=<encoded>
    const target = url.searchParams.get("target_url");
    if (target) {
      try {
        const dec = decodeURIComponent(target);
        return extractGoodsId(dec);
      } catch {}
    }

    // 4) Иногда temuto редиректит на kwcdn с параметром, внутри которого есть goods_id
    const whole = u;
    const m2 = whole.match(/goods_id=(\d{6,})/);
    if (m2) return m2[1];

    return null;
  } catch {
    return null;
  }
}

function buildViewUrl(goodsId: string) {
  return `https://www.temu.com/goods.html?goods_id=${goodsId}`;
}

// читаем CSV: можно два формата:
//  a) url
//  b) category,url
function readLinks(): { url: string; category?: string }[] {
  const raw = fs.readFileSync(CSV, "utf8");
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    comment: "#",
    trim: true,
  }) as any[];

  const hasCategory = "category" in rows[0];
  return rows
    .map((r) => ({
      url: (r.url || r.URL || r.link || "").trim(),
      category: hasCategory ? (r.category || r.Category || "").trim() : undefined,
    }))
    .filter((r) => r.url);
}

async function openWithDesktop(page: Page, url: string) {
  await page.setExtraHTTPHeaders({
    "accept-language": "en-US,en;q=0.9",
  });
  await page.setUserAgent(DESKTOP_UA);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
}

async function resolveToViewUrl(page: Page, shortOrLongUrl: string): Promise<{ viewUrl: string; goodsId: string } | null> {
  // если это уже веб-URL и goods_id виден — берём его
  const quick = extractGoodsId(shortOrLongUrl);
  if (quick) {
    return { viewUrl: buildViewUrl(quick), goodsId: quick };
  }

  // иначе идём в браузере (на десктопном UA) и берём итоговый URL
  await openWithDesktop(page, shortOrLongUrl);
  let finalUrl = page.url();

  // Temu иногда кидает на download-temu.html — извлекаем target_url
  let gid = extractGoodsId(finalUrl);
  if (!gid) {
    // бывают промежуточные редиректы — пробуем дождаться ещё одной навигации
    try {
      const resp = await page.waitForNavigation({ timeout: 5000 });
      if (resp) finalUrl = page.url();
    } catch {}
    gid = extractGoodsId(finalUrl);
  }

  if (!gid) return null;
  return { viewUrl: buildViewUrl(gid), goodsId: gid };
}

// вытаскиваем данные о товаре из страницы (название, цену, фото)
// стратегия: сначала JSON-LD, затем window.__INIT_STATE__ как fallback
async function scrapeProduct(page: Page, viewUrl: string) {
  await openWithDesktop(page, viewUrl);

  // Попытка 1: JSON-LD schema.org/Product
  const ld = await page.$$eval('script[type="application/ld+json"]', (nodes) => {
    try {
      for (const n of nodes) {
        const j = JSON.parse(n.textContent || "{}");
        if (j["@type"] === "Product") return j;
        if (Array.isArray(j)) {
          const p = j.find((x) => x["@type"] === "Product");
          if (p) return p;
        }
      }
    } catch {}
    return null;
  });

  let title = "";
  let price: any = "";
  let images: string[] = [];

  if (ld) {
    title = ld.name || "";
    if (ld.offers?.price) price = ld.offers.price;
    if (Array.isArray(ld.image)) images = ld.image;
    else if (ld.image) images = [ld.image];
  }

  // Попытка 2: window.__INIT_STATE__ / __NUXT__ / другие глобалы
  if (!title || !price || images.length === 0) {
    const raw = await page.content();
    // простые регулярки без завязки на конкретный фреймворк
    const t = title || (raw.match(/"title"\s*:\s*"([^"]{3,})"/)?.[1] ?? "");
    const p =
      price ||
      raw.match(/"price"\s*:\s*(\d+(\.\d+)?)/)?.[1] ||
      raw.match(/"min_price"\s*:\s*(\d+(\.\d+)?)/)?.[1] ||
      "";
    const imgs = images.length
      ? images
      : Array.from(
          new Set(
            Array.from(raw.matchAll(/https?:\/\/[^"]+\.(?:jpe?g|png|webp)/gi)).map(
              (m) => m[0]
            )
          )
        ).slice(0, 8);

    title = t || title;
    price = p || price;
    images = imgs;
  }

  // в качестве main_image берём первую
  const main_image = images[0] || "";
  return { title, price, images, main_image };
}

async function run() {
  const links = readLinks().slice(0, MAX_ITEMS);
  if (links.length === 0) {
    console.warn("manual_products.csv пуст!");
    return;
  }

  const browser: Browser = await chromium.launch({ headless: true });
  const page: Page = await browser.newPage();

  const items: FeedItem[] = [];

  for (const row of links) {
    const link_out = row.url.trim(); // партнёрка остаётся как есть

    // 1) Разворачиваем до view_url
    const resolved = await resolveToViewUrl(page, link_out);
    if (!resolved) {
      console.warn("Пропуск (не нашли goods_id):", link_out);
      continue;
    }

    const { viewUrl, goodsId } = resolved;

    // 2) Скрейпим карточку с view_url
    try {
      const data = await scrapeProduct(page, viewUrl);

      const item: FeedItem = {
        product_id: goodsId,
        title: data.title || "",
        price: data.price || "",
        main_image: data.main_image || "",
        images: data.images || [],
        url: viewUrl,          // рендер берём отсюда
        link_out,              // кликаут по партнёрке
        in_stock: true,
        last_seen: new Date().toISOString(),
        category: row.category || undefined,
      };

      items.push(item);
      console.log("✓", item.title || goodsId);
    } catch (e: any) {
      console.warn("Ошибка парсинга", viewUrl, e?.message || e);
    }
  }

  await browser.close();

  // Сгруппируем по категориям если она дана; иначе сложим в "all"
  const byCat = new Map<string, FeedItem[]>();
  for (const it of items) {
    const cat = (it.category || "all").toLowerCase();
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(it);
  }

  const feed = {
    generatedAt: new Date().toISOString(),
    categories: Array.from(byCat.entries()).map(([name, items]) => ({
      name,
      items,
    })),
  };

  ensureDir(OUT);
  fs.writeFileSync(OUT, JSON.stringify(feed, null, 2), "utf8");
  console.log(`\n✅ feed saved → ${OUT} (${items.length} items)`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

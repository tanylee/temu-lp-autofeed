import fs from 'fs';
import path from 'path';
import { chromium, devices, Page } from '@playwright/test';
import { sleep, withAffiliate, parsePrice, uniqueBy, softHumanize } from './helpers';

const ROOT = path.resolve(__dirname, '..');
const CFG   = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'settings.json'), 'utf8'));
const CATS: {name: string; url: string; aff?: string;}[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'categories.json'), 'utf8'));
const OUT   = path.join(ROOT, 'data', 'products.json');

type Item = { id: string; title: string; price: number | null; image: string; productUrl: string; description?: string; images?: string[]; };
type Feed = { generatedAt: string; categories: { name: string; items: Item[] }[] };

// ── safe read/merge (как раньше, укорочено) ────────────────────────────────────
function readPrevFeed(filePath: string): Feed | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { generatedAt: new Date().toISOString(), categories: [] };
    if (parsed && Array.isArray(parsed.categories)) {
      return { generatedAt: parsed.generatedAt || new Date().toISOString(),
        categories: parsed.categories.map((c:any)=>({ name: String(c?.name??''), items: Array.isArray(c?.items)?c.items:[] })) };
    }
    return { generatedAt: new Date().toISOString(), categories: [] };
  } catch { return null; }
}
function mergeIntoArchive(prev: Feed | null, byCat: Record<string, Item[]>) {
  const out: Feed = { generatedAt: new Date().toISOString(), categories: [] };
  const prevMap: Record<string, Item[]> =
    (prev && Array.isArray(prev.categories))
      ? Object.fromEntries(prev.categories.map(c => [c.name, Array.isArray(c.items) ? c.items : []]))
      : {};
  for (const [name, freshRaw] of Object.entries(byCat)) {
    const fresh = Array.isArray(freshRaw) ? freshRaw : [];
    const existed = prevMap[name] || [];
    const merged = uniqueBy([...fresh, ...existed], x => String(x.id));
    out.categories.push({ name, items: merged.slice(0, CFG.scrape.historyCapPerCategory || 100000) });
  }
  if (prev && Array.isArray(prev.categories)) {
    for (const c of prev.categories) {
      if (!out.categories.find(x => x.name === c.name)) out.categories.push({ name: c.name, items: Array.isArray(c.items)?c.items:[] });
    }
  }
  return out;
}

// ── анти-заглушки ─────────────────────────────────────────────────────────────
const BAD_URL = /(download-temu\.html|play\.google\.com|apps\.apple\.com|itunes\.apple\.com)/i;
const BAD_TITLE = /(google\s*play|app\s*store|shop on temu for exclusive offers)/i;
const isGoodTemuUrl = (u: string) => { try { const h=new URL(u).host; return ((/\.temu\.com$/i.test(h)||/temu\.to$/i.test(h)) && !BAD_URL.test(u)); } catch { return false; } };
const looksBad = (url?: string, title?: string) => (url && BAD_URL.test(url)) || (title && BAD_TITLE.test(title));

async function waitForGoods(page: Page, timeout = 20000) {
  await page.waitForSelector(
    'div[data-goods-id], div[data-sku-id], a[href*="goods_id"], a[href*="detail"]:has(img)',
    { timeout }
  ).catch(()=>{});
}

// ── основная выборка ──────────────────────────────────────────────────────────
async function scrapeCategory(page: Page, catName: string, url: string): Promise<Item[]> {
  const results: Item[] = [];
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CFG.scrape.timeoutMs });
  await page.waitForLoadState('networkidle', { timeout: CFG.scrape.timeoutMs }).catch(()=>{});
  await waitForGoods(page, 20000);

  if (/download-temu\.html/i.test(page.url())) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CFG.scrape.timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: CFG.scrape.timeoutMs }).catch(()=>{});
  }

  const sels = [
    'div[data-goods-id]',
    'div[data-sku-id]',
    'a[href*="goods_id"]',
    'a[href*="detail"]:has(img)'
  ];

  let pagesScraped = 0;
  while (pagesScraped < (CFG.scrape.maxPagesPerCategory || 1)) {
    let found = 0;

    for (const sel of sels) {
      const cards = await page.$$(sel);
      if (!cards.length) continue;

      for (const card of cards) {
        try {
          const dataId = await card.getAttribute('data-goods-id') || await card.getAttribute('data-sku-id');
          let href = await card.getAttribute('href') || await card.evaluate((el:any)=> el.querySelector('a')?.getAttribute('href') || '');
          if (href && !/^https?:/i.test(href)) href = new URL(href, page.url()).toString();
          if (!href || !isGoodTemuUrl(href)) continue;

          let id = dataId || '';
          if (!id && href) { const u = new URL(href); id = u.searchParams.get('goods_id') || u.searchParams.get('sku_id') || u.searchParams.get('item_id') || ''; }

          const title = await card.evaluate((el:any)=>(
            el.querySelector('.goods-title, ._title, .title, [data-title]')?.textContent
            || el.querySelector('img[alt]')?.getAttribute('alt')
            || el.getAttribute('title') || ''
          )?.trim());

          let image = await card.evaluate((el:any)=>{
            const img = el.querySelector('img'); const src = img?.getAttribute('src') || img?.getAttribute('data-src') || '';
            if (src) return src; const styled = el.querySelector('[style*="background-image"]');
            if (styled){ const m = /url\(["']?([^"')]+)["']?\)/.exec((styled as HTMLElement).getAttribute('style')||''); return m?.[1] || ''; }
            return '';
          });
          if (image && !/^https?:/i.test(image)) image = new URL(image, href || page.url()).toString();

          const priceText = await card.evaluate((el:any)=> el.querySelector('[data-price], .price, ._price, [class*="price"]')?.textContent?.trim() || '');
          const price = parsePrice(priceText);
          const productUrl = href;

          if (!title || !image) continue;
          if (looksBad(productUrl, title)) continue;

          results.push({ id: id || productUrl, title, price, image, productUrl });
          found++;
        } catch {}
      }
      if (found) break;
    }

    await page.evaluate(async () => {
      await new Promise<void>(res => { let y=0, step=700, max=7000; (function s(){ y+=step; scrollTo(0,y); if(y<max) requestAnimationFrame(s); else setTimeout(()=>res(),350); })(); });
    });

    const nextBtn = await page.$('a[aria-label*="Next" i], button[aria-label*="Next" i], a:has-text("Next")');
    if (nextBtn) { await nextBtn.click().catch(()=>{}); await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(()=>{}); await waitForGoods(page, 15000); }
    pagesScraped++;
    if (CFG.scrape.itemsPerCategoryCap && results.length >= CFG.scrape.itemsPerCategoryCap) break;
  }

  const unique = uniqueBy(results, x => String(x.id));
  return unique.slice(0, CFG.scrape.itemsPerCategoryCap || 9999);
}

// ── enrichment ────────────────────────────────────────────────────────────────
async function enrichDescriptions(page: Page, items: Item[], limit: number) {
  const targets = items.slice(0, limit);
  for (const it of targets) {
    try {
      if (looksBad(it.productUrl, it.title) || !isGoodTemuUrl(it.productUrl)) continue;
      await page.goto(it.productUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
      if (BAD_URL.test(page.url())) continue;

      const desc = await page.evaluate(()=>{
        const meta = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
        const txt = meta?.content || document.querySelector('[class*="desc"], [class*="description"]')?.textContent || '';
        return (txt || '').trim().replace(/\s+/g,' ').slice(0, 240);
      });
      const bigImg = await page.evaluate(()=>{
        const imgs = Array.from(document.querySelectorAll('img')).map((i:any)=> i.getAttribute('src') || i.getAttribute('data-src') || '').filter(Boolean);
        return imgs.filter((u)=>/https?:/.test(u)).slice(0,6);
      });
      if (desc) it.description = desc;
      if (bigImg?.length && !it.image) it.image = bigImg[0];
      if (bigImg?.length) it.images = bigImg;
    } catch {}
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const browser = await chromium.launch({ headless: CFG.scrape.headless !== false });
  const context = await browser.newContext({
    ...devices['Desktop Chrome'],
    locale: "en-US",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like

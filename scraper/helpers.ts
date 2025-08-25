import { Page } from "@playwright/test";

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function withAffiliate(url: string, cfg: { baseRedirect?: string; appendParams?: Record<string,string> } = {}) {
  let out = url;
  // 1) добавим UTM к самому URL товара
  if (cfg.appendParams && Object.keys(cfg.appendParams).length) {
    try {
      const u = new URL(out);
      const sp = new URLSearchParams(u.search);
      for (const [k, v] of Object.entries(cfg.appendParams)) sp.set(k, v);
      u.search = sp.toString();
      out = u.toString();
    } catch { /* noop */ }
  }
  // 2) если задана короткая партнёрская — оборачиваем товар через редирект
  if (cfg.baseRedirect) {
    const sep = cfg.baseRedirect.includes("?") ? "&" : "?";
    return `${cfg.baseRedirect}${sep}u=${encodeURIComponent(out)}`;
  }
  return out;
}

export async function softHumanize(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
}

export const parsePrice = (t?: string): number | null => {
  if (!t) return null;
  const m = t.replace(/[, \n]/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
};

export function uniqueBy<T>(arr: T[], keyFn: (x: T) => string) {
  const seen = new Set<string>(); const out: T[] = [];
  for (const it of arr) { const k = keyFn(it); if (!seen.has(k)) { seen.add(k); out.push(it); } }
  return out;
}

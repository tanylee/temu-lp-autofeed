import { Page } from "@playwright/test";

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type AffCfg = { baseRedirect?: string; appendParams?: Record<string,string> };

export function withAffiliate(url: string, globalCfg: AffCfg = {}, perCat?: AffCfg) {
  let out = url;
  const utm = perCat?.appendParams || globalCfg.appendParams;
  if (utm && Object.keys(utm).length) {
    try {
      const u = new URL(out);
      const sp = new URLSearchParams(u.search);
      for (const [k,v] of Object.entries(utm)) sp.set(k, v);
      u.search = sp.toString();
      out = u.toString();
    } catch {}
  }
  const base = perCat?.baseRedirect || globalCfg.baseRedirect;
  if (base) {
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}u=${encodeURIComponent(out)}`;
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

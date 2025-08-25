# Temu LP Autofeed (with affiliate redirect)

- Affiliate short link: **https://temu.to/k/gd1pto8322c** (настроено в `config/settings.json`).
- Финальная ссылка карточки строится как `temu.to/k/gd1pto8322c?u=<URL товара c UTM>`.
- Каждые 3 часа добавляется до 20 новых товаров на каждую нишу, архив не очищается.

## Start
1) `npm i && npm run install:pw`
2) `npm run scrape` — проверка `data/products.json`.
3) Открой `index.html` (или задеплой на Netlify/Vercel).
4) Включи Actions → **Temu Auto Feed (3h)**.

> Если короткая ссылка не принимает параметр `u`, убери `affiliate.baseRedirect` — останутся прямые товарные URL с UTM.

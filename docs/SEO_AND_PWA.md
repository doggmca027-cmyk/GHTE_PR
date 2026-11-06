# Public pages, crawlers and the offline shell

How the site is found (SEO, GEO, AI search) and how the app opens on a bad connection. Written 2026-11-06 while the Supabase API was restricted
(HTTP 402): **nothing here asks the database**, and none of it was tested against a live deployment (see "Check after the API is back").

## The pages

`src/seo/pages.ts` is the table of what exists. A page is `/<lang>/<slug>`:

| Address | What |
|---|---|
| `/` , `/<lang>/` | the app's home page; the English one is `/` (x-default), the other 14 languages `/<lang>/` |
| `/<lang>/buy-<platform>-<kind>` | `buy-telegram-followers`, `buy-instagram-likes`, `buy-spotify-plays`… (28 pairs, each with services on the storefront: checked against the catalogue on 2026-11-06) |
| `/<lang>/buy-<platform>-<flavor>-<kind>` | only `premium-followers` (Telegram) and `real-followers` (Instagram): the ones the storefront has services for |

`slow-auto-views` (Telegram) is **written, translated and tested but not published** (`PREPARED_FLAVORED` in `src/seo/pages.ts`): on 2026-11-06 the storefront had 13
Telegram auto-views cards, none of them slow and none with drip-feed, so a page for it would promise what the shop cannot sell. To publish it, put its line into
`FLAVORED`, add its slug to the two `:slug(...)` lists of `vercel.json` (a test compares the lists with the table), and add its address to `public/llm-context.txt`.
| `/<lang>/crypto-smm-panel`, `/<lang>/smm-panel-for-agencies` | topic pages |

An address that is not in the table is not a page (404), and a page exists only in a language that has its text (`LANDING_LANGS`: en, ru, uk, es, ar).
Home pages exist in all 15 languages (`HOME_META`).

* **People** get the app: `vercel.json` rewrites these addresses to `index.html`, `src/main.tsx` draws `components/seo/SeoLanding.tsx` (its own chunk, no sign-in,
  no request to Supabase).
* **Crawlers** (`src/seo/bots.ts`: Googlebot, Bing, Telegram/Facebook/X previews, GPTBot, ChatGPT-User, OAI-SearchBot, PerplexityBot, ClaudeBot…) get the finished
  HTML from `middleware.ts`: title, description, canonical, Open Graph, `hreflang` for every language of the page, JSON-LD (Organization, Product, FAQPage) and the
  text inside `#root`. The `matcher` lists **only these public addresses** (Vercel outside Next.js accepts path strings and nothing else: a `has` condition on the
  User-Agent made the first deployment fail), so the app's own entry `/` never passes through the middleware, and the crawler test is made in its code: a person on
  one of these addresses gets `next()` at once. A crawler on `/` gets the English `index.html` (its own title, canonical and x-default); the sitemap carries the
  hreflang of the home pages.
* `public/llm-context.txt` (`/llm-context.txt`, not linked from the app): what GRAM Hub is and what it does **not** promise, for AI crawlers.
* `sitemap.xml` is written at every build by `scripts/postbuild.ts` (`npm run generate-sitemap` does it by hand): 181 URLs, `hreflang` reciprocal on each.

## What the texts may say

`src/seo/copy.ts` says only what the platform really does: pay with TON into a prepaid USD balance, automatic refund, volume prices, minimum order $0.10, Refill and
drip-feed **only on the services that state them**, Real/HQ as labels of a service. It promises no immunity from the algorithms, no account safety, no position in a
search, no "cheapest", **no API** (customers have none), and never names the suppliers. `tests/seo-pages.test.ts` fails if a text says otherwise.

## Adding a language (for example German)

1. Write its entry in `COPY` (`src/seo/copy.ts`): the nouns, the four facts, the three answers, the two topics. Use a native speaker or a reviewed translation:
   the same text machine-translated into 14 languages is the "scaled content" a search engine punishes.
2. Put its code in `LANDING_LANGS` (`src/seo/pages.ts`) and the matching language code in the `rewrites` of `vercel.json` (`/:lang(en|ru|uk|es|ar)/…`).
3. `npm test`: `tests/seo-pages.test.ts` checks the entry is complete, `tests/pwa-config.test.ts` the rewrite. The sitemap, the hreflang tags and the middleware follow.

Adding a platform or a service: `SEO_PLATFORMS` (only pairs the catalogue sells; check with `scripts/catalog-coverage.ts`).

## The offline shell (PWA)

`vite.pwa.ts`. The shell (index.html, the entry bundle, vendor chunks, CSS, the icon) is precached; every other hashed file of `/assets/` is cached the first time
it is used. **`/api/*` is NetworkOnly, always**: the catalogue is kept per version by the CDN and by `src/lib/catalog-cache.ts` (see `catalog_version`), and a third
copy in the worker would show a stale catalogue under a new version. A new worker takes over at once and never reloads a page (an order being placed is not
interrupted). `sw.js` and the manifest are served `max-age=0` so an old worker cannot keep an old app.

## Optimistic ordering

At the tap of "Order Now" (`OrderModal.tsx`) the balance drops (`debitWallet` in `AuthContext`) and the order shows as "being confirmed" before the server answers.
The server's wallet always replaces ours; a refusal puts the balance back (the undo) and brings the form back with the reason.

## Check after the API is back (not done: it was down)

1. `curl -A "Googlebot/2.1" https://<site>/es/buy-instagram-followers` returns the finished page (title, hreflang, JSON-LD, text); the same URL without the
   crawler's User-Agent returns the plain app. If the middleware does not run on Vercel, replace it by a rewrite with a `has` header condition (in vercel.json) to an Edge Function:
   the render code (`src/seo/render.ts`) does not change.
2. Every (platform, kind) in `SEO_PLATFORMS` has active services in the catalogue (`scripts/catalog-coverage.ts`); remove the pair that has none.
3. Search Console: submit `/sitemap.xml`, inspect one page of each language ("Test live URL" shows the HTML the middleware gave).
4. Install the app, go offline, reopen it: the shell opens; the catalogue shows the copy of the last visit.

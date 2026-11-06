// Vercel Routing Middleware (Edge). Gives CRAWLERS the finished page of a public address: the right <title>, description, canonical, Open Graph, hreflang for
// every language the page exists in, JSON-LD, and the text of the page inside #root. The app is a single-page application, so without this a crawler that
// does not run JavaScript (most AI crawlers, link previews) would read an empty shell. People never reach this code: the `matcher` below runs it only for a
// request whose User-Agent is a crawler, so ordinary traffic costs no middleware invocation and is not delayed.
//
//   /                                  the English home page      /<lang>/                  the home page in a language (15)
//   /<lang>/buy-<platform>-<kind>      a landing page             /<lang>/<topic>           a topic page   (see src/seo/pages.ts)
//
// What it does NOT do: ask the database (a crawl would cost Supabase egress, and it is restricted), guess a page that is not in the table (an unknown
// address is left to the normal routing, which answers 404), or ever fail a crawl: any error lets the request through untouched.

import { botFromLink } from './src/lib/telegram-bot'
import { isBot } from './src/seo/bots'
import { parseSeoPath, type SeoRoute } from './src/seo/pages'
import { renderSeoHtml } from './src/seo/render'

// A literal on purpose: Vercel reads `config` statically. The names are those of src/seo/bots.ts (a test keeps the two equal).
export const config = {
  matcher: [
    {
      source: '/((?!api/|assets/|.*\\..*).*)',
      has: [{ type: 'header', key: 'user-agent', value: '.*(Googlebot|Google-InspectionTool|bingbot|BingPreview|Applebot|DuckDuckBot|YandexBot|Baiduspider|TelegramBot|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|WhatsApp|Discordbot|GPTBot|ChatGPT-User|OAI-SearchBot|PerplexityBot|ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai|Amazonbot|CCBot|cohere-ai|meta-externalagent).*' }],
    },
  ],
}

/** "Carry on to the page as usual": what next() of Vercel's helper packages sends (the header is the whole mechanism). */
const next = (): Response => new Response(null, { headers: { 'x-middleware-next': '1' } })

/** The app's own index.html is the template; it is the same for every request of a deployment, so an instance keeps it for ten minutes. */
let template: { at: number; html: string } | null = null
const TEMPLATE_TTL_MS = 10 * 60_000

async function loadTemplate(origin: string, doFetch: typeof fetch): Promise<string | null> {
  if (template && Date.now() - template.at < TEMPLATE_TTL_MS) return template.html
  // the internal header makes this very request skip the middleware, whatever the User-Agent of the platform's own fetch is
  const res = await doFetch(`${origin}/`, { headers: { 'x-seo-internal': '1', accept: 'text/html' }, redirect: 'follow' })
  const html = res.ok && (res.headers.get('content-type') ?? '').includes('text/html') ? await res.text() : null
  if (html && html.includes('<div id="root">')) template = { at: Date.now(), html }
  return template?.html ?? null
}

/** The address pages are canonical under: APP_URL (like the sitemap), else Vercel's production URL, else the host that was asked. */
function siteOf(env: Record<string, string | undefined>, requested: string): string {
  const explicit = env.APP_URL?.trim().replace(/\/+$/, '')
  if (explicit && /^https:\/\//.test(explicit)) return explicit
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
  return vercel ? `https://${vercel}` : requested
}

export default async function middleware(
  request: Request,
  deps: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<Response> {
  try {
    if (request.headers.get('x-seo-internal')) return next()
    if (request.method !== 'GET' && request.method !== 'HEAD') return next()
    if (!isBot(request.headers.get('user-agent'))) return next() // the matcher already says so; this is the same test, for a call that does not come through it
    const url = new URL(request.url)
    const route: SeoRoute | null = url.pathname === '/' ? { lang: 'en', landing: { type: 'home' } } : parseSeoPath(url.pathname)
    if (!route) return next()
    const env = deps.env ?? (typeof process !== 'undefined' ? process.env : {})
    const html = await loadTemplate(url.origin, deps.fetch ?? fetch)
    if (!html) return next()
    const bot = botFromLink(env.VITE_TWA_RETURN_URL)
    const page = renderSeoHtml(html, siteOf(env, url.origin), route, { botUrl: bot ? `https://t.me/${bot}` : null })
    return new Response(request.method === 'HEAD' ? null : page, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate', Vary: 'User-Agent', 'Content-Language': route.lang },
    })
  } catch {
    return next()
  }
}

import { useEffect } from 'react'
import { languageOf } from '@/i18n/languages'
import { telegramBotUsername } from '@/lib/telegram-bot'
import { copyFor, pageText } from '@/seo/copy'
import { allLandings, landingPath, LANDING_LANGS, type SeoRoute } from '@/seo/pages'
import { pageJsonLd } from '@/seo/schema'
import { JsonLd } from './JsonLd'

/** Sets what the browser shows about the page (the title, the description, the canonical address, the language and its direction). Crawlers got the same from the middleware. */
function applyHead(route: SeoRoute, origin: string) {
  const text = pageText(route.lang, route.landing)
  const language = languageOf(route.lang)
  document.documentElement.lang = language.code
  document.documentElement.dir = language.dir
  document.title = text.title
  const meta = (selector: string, make: () => HTMLElement, attr: string, value: string) => {
    const el = document.head.querySelector<HTMLElement>(selector) ?? document.head.appendChild(make())
    el.setAttribute(attr, value)
  }
  meta('meta[name="description"]', () => Object.assign(document.createElement('meta'), { name: 'description' }), 'content', text.description)
  meta('link[rel="canonical"]', () => Object.assign(document.createElement('link'), { rel: 'canonical' }), 'href', origin + landingPath(route.lang, route.landing))
}

/**
 * A public landing page (programmatic SEO): the heading, the introduction, what the customer gets, the questions, and the ways in. It is rendered without the
 * app's shell and without signing in, so a visitor from a search costs the database nothing; the catalogue itself opens in the app (the buttons).
 * The words are src/seo/copy.ts, the same ones the middleware writes into the HTML for crawlers.
 */
export default function SeoLanding({ route }: { route: SeoRoute }) {
  const { lang, landing } = route
  const copy = copyFor(lang)
  const text = pageText(lang, landing)
  const language = languageOf(lang)
  const bot = telegramBotUsername()
  const origin = window.location.origin
  useEffect(() => { applyHead(route, origin) }, [route, origin])

  const siblings = allLandings().filter((l) => JSON.stringify(l) !== JSON.stringify(landing))
  const button = 'inline-flex items-center justify-center rounded-2xl px-5 py-3 text-[15px] font-bold transition-transform active:scale-95'

  return (
    <div dir={language.dir} lang={language.code} className="min-h-[100dvh] bg-gradient-to-b from-screen to-screen-end px-5 py-8 text-content-primary">
      {/* one block per object, as the middleware writes them for crawlers */}
      {pageJsonLd(origin, lang, landing, { botUrl: bot ? `https://t.me/${bot}` : null }).map((data, i) => <JsonLd key={i} data={data} />)}
      <main className="mx-auto max-w-2xl space-y-6">
        <h1 className="text-2xl font-extrabold leading-tight">{text.h1}</h1>
        <p className="text-[15px] leading-relaxed text-content-secondary">{text.intro}</p>
        <div className="flex flex-wrap gap-3">
          {bot && <a href={`https://t.me/${bot}`} className={`${button} bg-brand text-white`}>{copy.ctaTelegram}</a>}
          <a href="/" className={`${button} ${bot ? 'bg-surface text-brand' : 'bg-brand text-white'}`}>{copy.ctaWeb}</a>
        </div>

        <section className="rounded-3xl bg-surface p-5">
          <h2 className="mb-3 text-lg font-bold">{copy.factsHeading}</h2>
          <ul className="list-disc space-y-2 ps-5 text-[15px] text-content-secondary">
            {copy.facts.map((f) => <li key={f}>{f}</li>)}
          </ul>
        </section>

        <section className="rounded-3xl bg-surface p-5">
          <h2 className="mb-3 text-lg font-bold">{copy.faqHeading}</h2>
          <dl className="space-y-4 text-[15px]">
            {copy.faq.map((f) => (
              <div key={f.q}>
                <dt className="font-bold">{f.q}</dt>
                <dd className="mt-1 text-content-secondary">{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <nav aria-label="Pages" className="space-y-2">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {siblings.map((l) => <li key={landingPath(lang, l)}><a className="text-brand underline-offset-2 hover:underline" href={landingPath(lang, l)}>{pageText(lang, l).h1}</a></li>)}
          </ul>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 pt-2 text-xs text-content-muted">
            {LANDING_LANGS.filter((l) => l !== lang).map((l) => <li key={l}><a href={landingPath(l, landing)} hrefLang={l}>{languageOf(l).name}</a></li>)}
          </ul>
        </nav>
      </main>
    </div>
  )
}

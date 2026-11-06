// Schema.org structured data (JSON-LD) for the public pages and for a service of the catalogue. PURE: the same builders feed the React component
// (components/seo/JsonLd.tsx), the Edge middleware that gives crawlers the finished page, and the tests.
//
// WHAT IS NEVER WRITTEN HERE: a price that is not known. The landing pages are written without asking the database (it costs Supabase egress and is
// down when it is restricted), so a landing page has NO Offer unless `priceFromUsd` is given by someone who knows it; a service of the catalogue has its
// own real price (catalogServiceLd). A made-up price in structured data is a policy violation for search engines and a false statement to a customer.

import type { LangCode } from '../i18n/languages.ts'
import { copyFor, pageText } from './copy.ts'
import { landingPath, type Landing } from './pages.ts'

type Json = Record<string, unknown>

export const BRAND = 'GRAM Hub'

export function organizationLd(site: string, botUrl?: string | null): Json {
  const origin = site.replace(/\/+$/, '')
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: BRAND,
    url: `${origin}/`,
    logo: `${origin}/tonconnect-icon.png`,
    ...(botUrl ? { sameAs: [botUrl] } : {}),
  }
}

/** A landing page as a Product; with an Offer only when the price from which it is sold is given (never invented). */
export function landingProductLd(site: string, lang: LangCode, landing: Extract<Landing, { type: 'service' }>, priceFromUsd?: number): Json {
  const origin = site.replace(/\/+$/, '')
  const text = pageText(lang, landing)
  const url = `${origin}${landingPath(lang, landing)}`
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: text.h1,
    description: text.description,
    url,
    brand: { '@type': 'Brand', name: BRAND },
    category: `${landing.platform.name} ${landing.kind}`,
    inLanguage: lang,
    ...(priceFromUsd !== undefined && Number.isFinite(priceFromUsd) && priceFromUsd > 0
      ? { offers: { '@type': 'Offer', url, priceCurrency: 'USD', price: String(priceFromUsd), availability: 'https://schema.org/InStock' } }
      : {}),
  }
}

/** The questions of a landing page, as FAQPage (the same text the page shows). */
export function faqLd(lang: LangCode): Json {
  const faq = copyFor(lang).faq
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    inLanguage: lang,
    mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  }
}

/** Everything a page carries: the organisation always, the product and the questions on a service page, the questions on a topic page. */
export function pageJsonLd(site: string, lang: LangCode, landing: Landing, opts: { botUrl?: string | null; priceFromUsd?: number } = {}): Json[] {
  const out: Json[] = [organizationLd(site, opts.botUrl)]
  if (landing.type === 'service') out.push(landingProductLd(site, lang, landing, opts.priceFromUsd), faqLd(lang))
  if (landing.type === 'topic') out.push(faqLd(lang))
  return out
}

/** What the catalogue knows about one of its services (the fields of ICatalogService that matter here). */
export interface CatalogServiceFacts {
  name: string
  sku?: string | null
  platformName: string
  /** Retail price per 1,000 units, USD: the real one. */
  ratePer1000: number
  minQuantity: number
  maxQuantity: number
  url?: string
}

/** A service of the catalogue as Product + Offer: the price is per 1,000 units (UnitPriceSpecification), the quantities are the service's own limits. */
export function catalogServiceLd(s: CatalogServiceFacts): Json {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: s.name,
    ...(s.sku ? { sku: s.sku } : {}),
    brand: { '@type': 'Brand', name: BRAND },
    category: s.platformName,
    offers: {
      '@type': 'Offer',
      ...(s.url ? { url: s.url } : {}),
      priceCurrency: 'USD',
      price: String(s.ratePer1000),
      availability: 'https://schema.org/InStock',
      eligibleQuantity: { '@type': 'QuantitativeValue', minValue: s.minQuantity, maxValue: s.maxQuantity, unitText: 'units' },
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: String(s.ratePer1000),
        priceCurrency: 'USD',
        referenceQuantity: { '@type': 'QuantitativeValue', value: 1000, unitText: 'units' },
      },
    },
  }
}

/** The JSON of a <script type="application/ld+json">: "<" is escaped so that nothing in the data can close the tag. */
const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)
export const ldScript = (data: unknown): string => JSON.stringify(data).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029')

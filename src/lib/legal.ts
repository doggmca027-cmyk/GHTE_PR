// The public legal pages (public/terms.html, public/ru/terms.html, ...): Russian and Ukrainian readers get their own version,
// everyone else the English one (also the x-default of the pages' hreflang set). Clean URLs, as the sitemap lists them.
import type { LangCode } from '@/i18n'

export type LegalDoc = 'terms' | 'privacy'

export const legalDocPath = (doc: LegalDoc, lang: LangCode): string => (lang === 'ru' || lang === 'uk' ? `/${lang}/${doc}` : `/${doc}`)

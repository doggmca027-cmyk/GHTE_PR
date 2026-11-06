import { catalogServiceLd, ldScript, type CatalogServiceFacts } from '@/seo/schema'

/**
 * Structured data (schema.org JSON-LD) in the page. The data is escaped so that nothing in it can close the tag (see ldScript). A <script> of this type is
 * data, not code: the page's Content-Security-Policy does not apply to it and nothing is executed.
 */
export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ldScript(data) }} />
}

/** A service of the catalogue as Product + Offer, with its real price per 1,000 (never an invented one). */
export function ServiceJsonLd({ service }: { service: CatalogServiceFacts }) {
  return <JsonLd data={catalogServiceLd(service)} />
}

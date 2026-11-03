// The segments of a storefront card (services.segments, migration 20261231000300): what its name says it is. The database computes them; the app only
// reads, shows and filters on them.
import type { Segment } from '@/types/catalog'

/** In the order the chips and the badges show them. */
export const SEGMENT_IDS: readonly Segment[] = ['premium', 'guaranteed', 'safe']

/** The segments of a row, as the app knows them: the known ones, once each, in the usual order. */
export function segmentsFromRow(value: unknown): Segment[] {
  if (!Array.isArray(value)) return []
  return SEGMENT_IDS.filter((id) => value.includes(id))
}

/** The PostgREST filter that keeps the cards of this segment (array contains): `segments=cs.{premium}`. */
export const segmentParam = (segment: Segment): string => `segments=${encodeURIComponent(`cs.{${segment}}`)}`

/** The offline catalogue (npm run dev) has no database to ask: a light reading of the name, close to the SQL service_segments. Never used for real cards. */
export function mockSegments(name: string): Segment[] {
  const no = /\b(no|non)[\s-]*refill|\bbots?\b/i.test(name)
  return segmentsFromRow([
    !no && /\b(hq|uhq|premium|real|verified|high quality)\b/i.test(name) ? 'premium' : null,
    !no && /refill|guarantee|non[\s-]*drop|lifetime/i.test(name) ? 'guaranteed' : null,
    /\b(slow|organic|natural|gradual)\b/i.test(name) && !/bot/i.test(name) ? 'safe' : null,
  ])
}

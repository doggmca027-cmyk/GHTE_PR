// Quality before price (migration 20261225000000). Pure, no I/O. Card names are in the form "YouTube Likes [refill: 30 days] [real]", panel
// names in the panel's own form ("TikTok Likes | HQ | Non-Drop | R30"). The SQL twins (service_name_is_quality, offer_quality_score) keep the
// same patterns; tests/provider-rotation.test.ts runs both over the same names.
//
//   * a QUALITY CARD promises something: its name says refill, HQ / high quality, real, organic or non-drop (a guarantee counts as refill)
//   * an explicit "no refill" or "bot" takes the promise back, whatever else the name says. "No bots", "Bot Starts" and "Chat Bot" are not
//     bots in that sense: the first is a promise and the others are the product
//   * a plain "Views" card promises nothing and so is not a quality card, but "Views [refill: lifetime]" is
//
// On a quality card an offer scores 2 from a premium panel (providers.is_premium), 1 when its own name makes such a promise, otherwise 0, and
// the higher score wins whatever the price. An offer whose name takes the promise back scores 0 even on a premium panel. On any other card
// every offer scores 0: there the cheapest wins, as everywhere else.

const NO_GUARANTEE = /\b(?:no|non|not|without)[\s-]*(?:refill|guarantee)|\bnorefill|\brefill\s*[:=-]?\s*(?:no|none|not)\b(?![\s-]*drop)|\brefill\s*[:=-]?\s*0(?![\d-])|(?<!\b(?:no|non|chat|without|anti)[\s-])\bbots?\b(?![\s-]*starts?)/i
const PROMISE = /\brefill|\bguarantee|\bu?hq\b|\bhigh[\s-]*quality|\bnon[\s-]*drop|\bno[\s-]*drops?\b|\bdrops?\s*:\s*no\b|\breal\b(?![\s-]*time)|\borganic/i

/** The card's name promises quality. */
export const isQualityCard = (serviceName: string): boolean => !NO_GUARANTEE.test(serviceName) && PROMISE.test(serviceName)

/** How much this offer keeps a quality card's promise: 2 premium panel, 1 its name says so, 0 nothing. */
export function offerQualityScore(panelName: string | null | undefined, premium: boolean | null | undefined): number {
  const name = panelName ?? ''
  if (NO_GUARANTEE.test(name)) return 0
  if (premium === true) return 2
  return PROMISE.test(name) ? 1 : 0
}

/** Scores the offers of one card: every offer 0 on a card that promises nothing or whose name is not known. */
export const qualityScorer = (serviceName: string | null | undefined): ((panelName: string | null | undefined, premium: boolean | null | undefined) => number) =>
  serviceName && isQualityCard(serviceName) ? offerQualityScore : () => 0

// Which reaction a reaction service delivers: panels say it with an emoji ("[😢]"), a word in a tag ("[Ха-ха]", "[Haha]") or in quotes
// («star»), in the English name or only in the original one (the translation of some Facebook reactions lost the word). It sets the
// variants of a group apart, so it is always shown in full: on the switch and as a badge of the card.
import { tr } from '@/i18n'
import { nameTags } from './variants'

export interface Reaction {
  emoji: string
  /** i18n key */
  label: string
}

interface Known {
  reaction: Reaction
  /** A whole tag (lower case, trailing "!" / "." trimmed) that is one of these words. */
  words: RegExp
  /** Any of these emojis anywhere in the name. */
  emojis: RegExp
}

const R = (emoji: string, label: string, words: RegExp, emojis: RegExp): Known => ({ reaction: { emoji, label }, words, emojis })

const KNOWN: Known[] = [
  R('👍', tr('Like'), /^(like|нравится|подобається|лайк)$/u, /👍/u),
  R('❤️', tr('Love'), /^(love|super|супер|сердце|heart|серце)$/u, /❤|♥/u),
  R('🥰', tr('Care'), /^(care|мы вместе|ми разом)$/u, /🥰|🤗/u),
  R('😆', tr('Haha'), /^(haha|ха-?ха|ха ха)$/u, /😆|😂|🤣/u),
  R('😮', tr('Wow'), /^(wow|ух ты|ого)$/u, /😮|😲/u),
  R('😢', tr('Sad'), /^(sad|сочувствую|грустно|сумно)$/u, /😢|😥|😭/u),
  R('😡', tr('Angry'), /^(angry|возмутительно|злость|обурливо)$/u, /😡|😠|🤬/u),
  R('⭐', tr('Star'), /^(star|stars|звезда|звёзды|зірка)$/u, /⭐|🌟/u),
  R('🔥', tr('Fire'), /^(fire|огонь|вогонь)$/u, /🔥/u),
  R('🎉', tr('Party'), /^(party|праздник|свято)$/u, /🎉/u),
]
// a mix of reactions, written inside a longer tag ("Positive Emoji Reactions")
const MIXED: Known[] = [
  R('👍', tr('Positive'), /(^|\s)(positive|позитивн\S*|положительн\S*)(\s|$)/iu, /(?!)/u),
  R('👎', tr('Negative'), /(^|\s)(negative|негативн\S*|отрицательн\S*)(\s|$)/iu, /(?!)/u),
]

const IS_REACTION_SERVICE = /reaction|реакци|emoji|эмодзи/i

/** The reaction a service delivers, or null (not a reaction service, or one that does not say which: "random", a mix of all). */
export function reactionOf(name: string, nameI18n?: Record<string, string>): Reaction | null {
  const names = [name, nameI18n?.ru ?? ''].filter(Boolean)
  if (!names.some((n) => IS_REACTION_SERVICE.test(n))) return null
  const parts = names.flatMap((n) => [...nameTags(n), ...[...n.matchAll(/«([^»]+)»/g)].map((m) => m[1])])
  for (const raw of parts) {
    const tag = raw.toLowerCase().replace(/[!.?]+$/u, '').trim()
    const hit = KNOWN.find((k) => k.words.test(tag))
    if (hit) return hit.reaction
  }
  // the emoji itself in a tag ("Facebook [😢] Post Reactions"); not anywhere in the name, where 🔥 or ⭐ are often mere decoration
  for (const raw of parts) {
    const hit = KNOWN.find((k) => k.emojis.test(raw))
    if (hit) return hit.reaction
  }
  for (const raw of parts) {
    const hit = MIXED.find((k) => k.words.test(raw))
    if (hit) return hit.reaction
  }
  return null
}

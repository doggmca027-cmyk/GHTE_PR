// How people really write to a support chat: typos ("титк ток", "пыдписников"), Ukrainian and mixed Russian-Ukrainian ("суржик"), a word split in two
// ("тик ток") or glued ("tiktok"). Pure and tiny, so it runs on the Edge runtime and is tested without a network.
//
// Two layers work together in chat-rag.ts: the regexes there list the spellings that are known (the synonym map), and `reads` below catches the typos
// nobody listed, by comparing the words of the message with a few stems.

const FOLDED: Record<string, string> = { ё: 'е', і: 'и', ї: 'и', є: 'е', ґ: 'г' }

/**
 * The message in lower case with the Ukrainian letters read as their Russian neighbours ("тік ток" -> "тик ток", "підписник" -> "пидписник") and
 * ё as е. The regexes and stems of the chat are written for this form, so a Ukrainian customer needs no list of their own.
 */
export const fold = (text: string): string => text.toLowerCase().replace(/[ёіїєґ]/g, (c) => FOLDED[c]!)

/** `a` and `b` are at most `max` edits apart (insert, delete, replace, swap of two neighbours). */
export function withinEdits(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false
  let twoBack: number[] | null = null
  let back = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      let best = Math.min(back[j]! + 1, row[j - 1]! + 1, back[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (twoBack && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, twoBack[j - 2]! + 1)
      row.push(best)
    }
    twoBack = back
    back = row
  }
  return back[b.length]! <= max
}

/**
 * How many typos a stem forgives: none for short ones ("лайк" is its own word), one for 5-8 letters, two for longer. The first letter must be right:
 * people rarely mistype it, and it keeps "switch" from being Twitch or "interest" Pinterest.
 */
const forgiven = (stem: string): number => (stem.length >= 9 ? 2 : stem.length >= 5 ? 1 : 0)

function close(word: string, stem: string): boolean {
  if (word[0] !== stem[0]) return false
  const max = forgiven(stem)
  // an inflected word ("подписчиков") starts with the stem: compare the beginning of it, a letter shorter or longer too
  return [stem.length - 1, stem.length, stem.length + 1].some((len) => len > 0 && withinEdits(word.slice(0, len), stem, max))
}

/**
 * Does a word of the text read as one of the stems, give or take a typo? Two neighbouring words are also tried glued ("тик" + "ток" = "тикток"),
 * since a name written in two words is the same name. The text is expected folded (see `fold`), the stems too.
 */
export function reads(text: string, stems: readonly string[]): boolean {
  const words = text.match(/[a-zа-я0-9]+/g) ?? []
  const spots = [...words, ...words.slice(1).map((w, i) => words[i]! + w)]
  return stems.some((stem) => spots.some((spot) => close(spot, stem)))
}

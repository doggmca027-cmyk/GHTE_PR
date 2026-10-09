// Messages the customer reads that are written OUTSIDE the app's screens: the shared validators (also run by the Edge Functions) and the
// fixed sentences the Edge Functions answer with. They arrive in English; `tm()` shows them in the customer's language when the exact
// sentence is known here. A sentence not listed (a new server message, a provider's own text) is shown as it came: never blank.
import { t, tr } from './index'

/** Sentences with a number in them: matched by shape, the number is passed on. */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Minimum is (.+)$/, tr('Minimum is {n}')],
  [/^Maximum is (.+)$/, tr('Maximum is {n}')],
  [/^Minimum deposit is (.+)$/, tr('Minimum deposit is {n}')],
  [/^Maximum deposit is (.+)$/, tr('Maximum deposit is {n}')],
  [/^Quantity must be between (.+?) and (.+?)\.?$/, tr('Quantity must be between {a} and {b}.')],
]

/** Fixed sentences. Listing them here is what makes the test require a translation for each of the 14 other languages. */
export const KNOWN_MESSAGES = [
  // order form validators
  tr('Enter a quantity'),
  tr('Use whole numbers only'),
  tr('Quantity is too large'),
  tr('Paste the link to promote'),
  tr('Link is too long'),
  tr('Link must not contain spaces'),
  tr('Link contains invalid characters'),
  tr('Enter a valid link, e.g. https://t.me/channel'),
  tr('Link must not contain a username or password'),
  // deposit validators
  tr('Enter a deposit amount'),
  tr('Use at most 2 decimal places'),
  // place-order, quote-order
  tr('Insufficient balance.'),
  tr('Your account is suspended.'),
  tr('This service is temporarily unavailable. You were not charged.'),
  tr('This service is no longer available.'),
  tr('This promo code does not exist.'),
  tr('This promo code is no longer valid.'),
  tr('This promo code has been used up.'),
  tr('You have already used this promo code.'),
  tr('This promo code cannot be applied to this order.'),
  tr('Order total is too small.'),
  tr('This request key was already used for a different order.'),
  tr('Something went wrong. You were not charged.'),
  tr('Sign in again.'),
  // deposits
  tr('Could not get a live exchange rate. Please try again in a minute.'),
  tr('Deposits are temporarily unavailable.'),
  tr('Deposit not found.'),
  tr('USDT deposits are not available yet. Please use TON.'),
  tr('You have several unpaid deposits open. Please complete or wait for them to expire.'),
  tr('Could not reach the TON network. Please try again shortly.'),
  tr('Waiting for the transaction to appear on the TON network.'),
  tr('This transaction was already credited.'),
  tr('This deposit has failed.'),
  tr('We received less than the required amount. Please contact support with your deposit ID.'),
  tr('The payment arrived after this deposit expired. Please contact support with your deposit ID.'),
  tr('Please reopen the app and try again.'),
  // support
  tr('New tickets are temporarily unavailable. Please try again later.'),
  tr('Ticket not found.'),
  tr('That order was not found.'),
  tr('This ticket is closed.'),
  tr('You have too many open tickets. Please wait for an answer.'),
  tr('Too many messages. Please try again later.'),
  // any function
  tr('Something went wrong. Please try again.'),
  tr('Server is not configured.'),
] as const

/** Translates a message that was produced in English somewhere else; unknown sentences are returned unchanged. */
export function tm(message: string): string {
  for (const [re, key] of PATTERNS) {
    const m = re.exec(message)
    if (m) return key.includes('{a}') ? t(key, { a: m[1], b: m[2] }) : t(key, { n: m[1] })
  }
  return t(message)
}

// What an ad-network postback must look like and how it is verified. Pure (no I/O): the ad-webhook function feeds it the
// request parameters and the environment, and acts on the decision.
//
// The reward AMOUNT is never read from a postback: only WHO (our user), WHICH network and WHICH transaction. The payout comes
// from ad_providers.reward_amount in the database.
//
// !! The parameter names and the signed string below are this project's contract with each network, set up in the network's
// !! dashboard (the postback URL carries the parameters). They are the one place to adapt to a network's real postback format.

import { verifyHmacSha256, verifyMd5 } from './ad-signatures.ts'

export type AdMethod = 'hmac-sha256' | 'md5'

export interface AdProtocol {
  method: AdMethod
  /** Query / form parameter that carries our user's Telegram id. */
  userParam: string
  /** The network's own id for this view (what makes the postback idempotent). */
  txParam: string
  signatureParam: string
}

/**
 * hmac-sha256:  signature = hex(HMAC_SHA256(secret, "<user>:<tx>"))
 * md5:          signature = hex(MD5("<user>:<tx>:<secret>"))      (the secret is part of the signed string)
 */
export const AD_PROTOCOLS: Readonly<Record<string, AdProtocol>> = {
  adsgram: { method: 'md5', userParam: 'userid', txParam: 'tx_id', signatureParam: 'sign' },
  monetag: { method: 'hmac-sha256', userParam: 'telegram_id', txParam: 'ymid', signatureParam: 'sign' },
  gigapub: { method: 'hmac-sha256', userParam: 'user_id', txParam: 'event_id', signatureParam: 'signature' },
}

/** ADSGRAM_SECRET, MONETAG_SECRET, GIGAPUB_SECRET. */
export const secretEnvName = (provider: string): string => `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_SECRET`

export type PostbackDecision =
  | { ok: true; provider: string; telegramId: number; txId: string }
  | { ok: false; status: 400 | 401 | 404 | 503; error: string }

const TX_RE = /^[A-Za-z0-9._:-]{1,128}$/
const PROVIDER_RE = /^[a-z0-9_]{2,30}$/

export function signedString(protocol: AdProtocol, user: string, tx: string, secret: string): string {
  return protocol.method === 'md5' ? `${user}:${tx}:${secret}` : `${user}:${tx}`
}

/**
 * Order of refusals: unknown network (404) -> no secret configured (503, fails closed: never accepts unsigned traffic) ->
 * malformed parameters (400) -> wrong signature (401). The 401 never says which part was wrong.
 */
export async function checkPostback(
  providerRaw: unknown,
  params: Pick<URLSearchParams, 'get'>,
  env: { get(name: string): string | undefined },
): Promise<PostbackDecision> {
  const provider = typeof providerRaw === 'string' ? providerRaw.trim().toLowerCase() : ''
  const protocol = PROVIDER_RE.test(provider) ? AD_PROTOCOLS[provider] : undefined
  if (!protocol) return { ok: false, status: 404, error: 'unknown_provider' }

  const secret = env.get(secretEnvName(provider))
  if (!secret) return { ok: false, status: 503, error: 'provider_not_configured' }

  const user = params.get(protocol.userParam) ?? ''
  const tx = params.get(protocol.txParam) ?? ''
  const signature = params.get(protocol.signatureParam)
  if (!/^[1-9][0-9]{0,15}$/.test(user) || !TX_RE.test(tx) || !signature) return { ok: false, status: 400, error: 'invalid_postback' }

  const payload = signedString(protocol, user, tx, secret)
  const valid = protocol.method === 'md5' ? verifyMd5(payload, signature) : await verifyHmacSha256(payload, secret, signature)
  if (!valid) return { ok: false, status: 401, error: 'invalid_signature' }

  const telegramId = Number(user)
  if (!Number.isSafeInteger(telegramId)) return { ok: false, status: 400, error: 'invalid_postback' }
  return { ok: true, provider, telegramId, txId: tx }
}

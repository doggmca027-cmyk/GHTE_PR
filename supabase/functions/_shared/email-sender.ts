// Transactional e-mail: the 6-digit codes of the web sign-in, sent through the Resend HTTP API.
//
//   RESEND_API_KEY   enables sending. Without it nothing is sent and the caller is told 'unconfigured' (production then refuses to
//                    issue codes instead of pretending: a code nobody receives is a locked-out customer).
//   EMAIL_FROM       sender, e.g. "GRAM Hub <no-reply@your-domain>" (a domain verified in Resend). Default: Resend's test sender,
//                    which only delivers to the Resend account's own address.
//   MOCK_MODE=true   (outside a hosted project only, see mock-guard.ts) logs the code instead of sending, for local development.
//
// The code itself is never logged in production, and the API key never leaves this module.

import { mockModeEnabled, type EnvReader } from './mock-guard.ts'

export const DEFAULT_FROM = 'GRAM Hub <onboarding@resend.dev>'
const RESEND_URL = 'https://api.resend.com/emails'
const TIMEOUT_MS = 10_000

export type EmailLang = 'en' | 'ru' | 'uk'
export type CodeEmailPurpose = 'register_verify' | 'login_code' | 'reset_password'

export interface CodeEmail {
  to: string
  code: string
  purpose: CodeEmailPurpose
  lang: EmailLang
  minutes: number
}

export type SendOutcome = 'sent' | 'mock_logged' | 'unconfigured' | 'failed'

const TEXT: Record<EmailLang, { subject: Record<CodeEmailPurpose, string>; lead: Record<CodeEmailPurpose, string>; valid: string; ignore: string }> = {
  en: {
    subject: { register_verify: 'Your GRAM Hub sign-up code', login_code: 'Your GRAM Hub sign-in code', reset_password: 'Reset your GRAM Hub password' },
    lead: { register_verify: 'Enter this code to finish creating your account:', login_code: 'Enter this code to sign in:', reset_password: 'Enter this code to set a new password:' },
    valid: 'The code is valid for {m} minutes. Never share it with anyone, including support.',
    ignore: 'If you did not ask for it, ignore this e-mail: nothing changes without the code.',
  },
  ru: {
    subject: { register_verify: 'Код регистрации GRAM Hub', login_code: 'Код входа в GRAM Hub', reset_password: 'Сброс пароля GRAM Hub' },
    lead: { register_verify: 'Введите этот код, чтобы завершить регистрацию:', login_code: 'Введите этот код для входа:', reset_password: 'Введите этот код, чтобы задать новый пароль:' },
    valid: 'Код действует {m} минут. Никому его не сообщайте, даже поддержке.',
    ignore: 'Если вы его не запрашивали, просто проигнорируйте письмо: без кода ничего не изменится.',
  },
  uk: {
    subject: { register_verify: 'Код реєстрації GRAM Hub', login_code: 'Код входу в GRAM Hub', reset_password: 'Скидання пароля GRAM Hub' },
    lead: { register_verify: 'Введіть цей код, щоб завершити реєстрацію:', login_code: 'Введіть цей код для входу:', reset_password: 'Введіть цей код, щоб задати новий пароль:' },
    valid: 'Код дійсний {m} хвилин. Нікому його не повідомляйте, навіть підтримці.',
    ignore: 'Якщо ви його не запитували, просто проігноруйте лист: без коду нічого не зміниться.',
  },
}

export const emailLang = (code: string | null | undefined): EmailLang => {
  const l = (code ?? '').toLowerCase().slice(0, 2)
  return l === 'ru' || l === 'uk' ? l : 'en'
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Subject, plain text and HTML of a code e-mail (no external images, no tracking). */
export function renderCodeEmail(m: CodeEmail): { subject: string; text: string; html: string } {
  const t = TEXT[m.lang]
  const valid = t.valid.replace('{m}', String(m.minutes))
  const subject = t.subject[m.purpose]
  const text = `${t.lead[m.purpose]}\n\n${m.code}\n\n${valid}\n${t.ignore}\n\nGRAM Hub`
  const html = `<!doctype html><html lang="${m.lang}"><body style="margin:0;background:#f5f9fd;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#0f172a">
<div style="max-width:480px;margin:0 auto;padding:32px 20px">
<p style="font-size:20px;font-weight:800;margin:0 0 24px">GRAM Hub</p>
<div style="background:#fff;border:1px solid #dbeafe;border-radius:20px;padding:24px">
<p style="margin:0 0 16px;font-size:15px">${escapeHtml(t.lead[m.purpose])}</p>
<p style="margin:0 0 16px;font-size:34px;font-weight:800;letter-spacing:8px;font-family:ui-monospace,Menlo,monospace">${escapeHtml(m.code)}</p>
<p style="margin:0 0 8px;font-size:13px;color:#475569">${escapeHtml(valid)}</p>
<p style="margin:0;font-size:13px;color:#64748b">${escapeHtml(t.ignore)}</p>
</div></div></body></html>`
  return { subject, text, html }
}

export interface EmailSenderDeps {
  env: EnvReader
  fetchImpl?: typeof fetch
  log?: { info: (msg: string, f?: Record<string, unknown>) => void; warn: (msg: string, f?: Record<string, unknown>) => void }
}

/** Whether codes can reach anyone in this environment (a real key, or the local mock). */
export const emailConfigured = (env: EnvReader): boolean => Boolean(env.get('RESEND_API_KEY')?.trim()) || mockModeEnabled(env)

/** Never throws. */
export async function sendCodeEmail(m: CodeEmail, deps: EmailSenderDeps): Promise<SendOutcome> {
  const log = deps.log ?? { info: () => {}, warn: () => {} }
  const key = deps.env.get('RESEND_API_KEY')?.trim()
  if (!key) {
    if (mockModeEnabled(deps.env)) {
      // local development only (mockModeEnabled is false on every hosted project): the code is shown so the flow can be tried
      log.info('email mock: code not sent', { purpose: m.purpose, to_domain: m.to.split('@')[1], dev_code: m.code })
      return 'mock_logged'
    }
    log.warn('email not configured: RESEND_API_KEY is not set', { purpose: m.purpose, error_code: 'email_unconfigured' })
    return 'unconfigured'
  }
  const { subject, text, html } = renderCodeEmail(m)
  try {
    const res = await (deps.fetchImpl ?? fetch)(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: deps.env.get('EMAIL_FROM')?.trim() || DEFAULT_FROM, to: [m.to], subject, text, html }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.ok) {
      log.info('email sent', { purpose: m.purpose, to_domain: m.to.split('@')[1] })
      return 'sent'
    }
    log.warn('email provider refused', { purpose: m.purpose, status: res.status, error_code: 'email_refused' })
    return 'failed'
  } catch {
    log.warn('email provider unreachable', { purpose: m.purpose, error_code: 'email_unreachable' })
    return 'failed'
  }
}

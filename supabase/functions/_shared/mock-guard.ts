// MOCK_MODE is a development switch: orders are "accepted" without any provider, notifications are not sent and the TON rate falls back
// to a constant. On a deployed project it would be a silent way to take money and deliver nothing, so it is honoured ONLY outside a
// hosted Supabase project. Every Edge Function asks this module instead of reading the variable itself
// (tests/security-audit-remediation.test.ts enforces that).

export interface EnvReader {
  get(name: string): string | undefined
}

/** True on a hosted Supabase project (https://<ref>.supabase.co) or when the environment says it is production. */
export function isHostedProject(env: EnvReader): boolean {
  const label = (env.get('APP_ENV') ?? env.get('ENVIRONMENT') ?? '').trim().toLowerCase()
  if (label === 'production' || label === 'prod') return true
  const url = env.get('SUPABASE_URL')
  if (!url) return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.endsWith('.supabase.co') || host.endsWith('.supabase.in')
  } catch {
    return false
  }
}

/** MOCK_MODE=true counts only outside production; any other value, or no value, is "off". */
export function mockModeEnabled(env: EnvReader): boolean {
  return env.get('MOCK_MODE') === 'true' && !isHostedProject(env)
}

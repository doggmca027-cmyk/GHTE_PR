// npm run sync-services (pure parts, tested in tests/provider-rotation.test.ts). Keep to erasable syntax: the script runs without a build step.

export interface Panel {
  name: string
  apiUrl: string
}

/** The premium panels: they start without a key and with routing off, and their offers go first on a card that promises quality. */
export const PREMIUM_PANELS: Panel[] = [
  { name: 'Secsers', apiUrl: 'https://secsers.com/api/v2' },
  { name: 'MoreThanPanel', apiUrl: 'https://morethanpanel.com/api/v2' },
]

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`

/**
 * Creates the panels that are missing (the storefront's main catalogue: once routing is on, the sync publishes their English services into the
 * platform + action categories), marks them premium and lists them. Safe to repeat: an existing panel keeps its key, URL and switches.
 */
export function ensurePanelsSql(panels: Panel[]): string {
  const names = panels.map((p) => quote(p.name.toLowerCase())).join(', ')
  return `
    insert into providers (name, api_url, is_active, is_premium, catalog_mode, publish_mapping)
    select v.name, v.url, true, true, 'publish', 'canonical'
      from (values ${panels.map((p) => `(${quote(p.name)}, ${quote(p.apiUrl)})`).join(', ')}) v(name, url)
     where not exists (select 1 from providers p where lower(p.name) = lower(v.name));
    update providers set is_premium = true where lower(name) in (${names}) and not is_premium;
    select id, name, is_active, routing_enabled, api_key_encrypted is not null as has_key
      from providers where lower(name) in (${names}) order by name;`
}

export interface PanelRow {
  id: string
  name: string
  is_active: boolean
  routing_enabled: boolean
  has_key: boolean
}

export interface SyncAnswer {
  skipped?: string
  error?: string
  added?: number
  updated?: number
  deactivated?: number
  providers?: { status?: string; error?: string; warning?: string; published?: { created?: number; backlog?: number } }[]
}

export type SyncOutcome = { kind: 'busy' } | { kind: 'failed' | 'no_key'; line: string } | { kind: 'ok'; line: string; backlog: number }

/** What one sync-catalog answer means. A provider without a key is not a failure: it is the state a new panel starts in. */
export function readSyncAnswer(name: string, status: number, body: SyncAnswer | null): SyncOutcome {
  if (body?.skipped === 'another_run_in_progress') return { kind: 'busy' }
  const report = body?.providers?.[0]
  if (status !== 200 || !body || body.error) return { kind: 'failed', line: `${name}: FAILED (HTTP ${status}${body?.error ? `, ${body.error}` : ''})` }
  if (report?.status === 'failed') return { kind: 'failed', line: `${name}: FAILED (${report.error ?? 'unknown error'})` }
  if (report?.status === 'skipped' && /no API key/.test(report.error ?? '')) return { kind: 'no_key', line: `${name}: no API key yet, nothing imported` }
  if (report?.status === 'skipped') return { kind: 'failed', line: `${name}: nothing imported (${report.error ?? 'unknown reason'})` }
  if (!report) return { kind: 'failed', line: `${name}: the provider was not synced (is it inactive?)` }
  const backlog = report.published?.backlog ?? 0
  const published = report.published ? `, ${report.published.created ?? 0} cards published, ${backlog} to go` : ''
  const warning = report.warning ? ` (warning: ${report.warning})` : ''
  return { kind: 'ok', backlog, line: `${name}: ${body.added ?? 0} new, ${body.updated ?? 0} updated, ${body.deactivated ?? 0} removed${published}${warning}` }
}

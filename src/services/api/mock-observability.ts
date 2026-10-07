// Offline System Health for dev mock mode: a believable snapshot run through the real judge (buildSystemHealth), so the
// screen shows every state (a late job, a failing provider, a stuck order, a critical case) without a backend.
import { buildSystemHealth, type RawHealth, type SystemHealth } from '../../../supabase/functions/_shared/observability.ts'

export function createMockObservability() {
  return {
    get(hours: number, now: number = Date.now()): SystemHealth {
      const ago = (min: number) => new Date(now - min * 60_000).toISOString()
      const checks = hours * 60
      const raw: RawHealth = {
        generated_at: new Date(now).toISOString(),
        window_hours: hours,
        db: { ok: true, now: new Date(now).toISOString() },
        orders: { stuck: 1, stuck_oldest_minutes: 34, held: 2, queue: { processing: 3, submitted: 5, in_progress: 12 } },
        reconciliation: {
          total: 2,
          cases: [
            { id: 'demo-case-1', entity_type: 'order', reason: 'needs_refund: provider_rejected', created_at: ago(95), amount: 12.5 },
            { id: 'demo-case-pay-1', entity_type: 'provider_payment', reason: 'Stuck in BROADCASTED for over 4 h: demo', created_at: ago(30), amount: 120 },
          ],
        },
        providers: [
          {
            id: 'demo-prov-1', name: 'Secsers (demo)', is_active: true, routing_enabled: true, health_status: 'healthy', last_health_check: ago(1),
            balance: 842.17, currency: 'USD', last_balance_sync: ago(1), low_balance_threshold: 10, checks, failed_checks: 2, avg_latency_ms: 310,
            max_latency_ms: 1840, last_error_kind: 'timeout', last_error_at: ago(140), errors_by_kind: { timeout: 2 }, orders: 148, orders_failed: 3, orders_held: 0,
          },
          {
            id: 'demo-prov-2', name: 'Backup panel (demo)', is_active: true, routing_enabled: true, health_status: 'unavailable', last_health_check: ago(1),
            balance: 6.4, currency: 'USD', last_balance_sync: ago(1), low_balance_threshold: 10, checks, failed_checks: Math.round(checks * 0.62), avg_latency_ms: 4200,
            max_latency_ms: 8000, last_error_kind: 'http 503', last_error_at: ago(1),
            errors_by_kind: { 'http 503': Math.round(checks * 0.5), timeout: Math.round(checks * 0.12) }, orders: 9, orders_failed: 4, orders_held: 2,
          },
        ],
        recent_provider_errors: [
          { provider_id: 'demo-prov-2', provider_name: 'Backup panel (demo)', error_kind: 'http 503', status: 'unavailable', latency_ms: 4100, checked_at: ago(1) },
          { provider_id: 'demo-prov-2', provider_name: 'Backup panel (demo)', error_kind: 'timeout', status: 'unavailable', latency_ms: 8000, checked_at: ago(2) },
          { provider_id: 'demo-prov-1', provider_name: 'Secsers (demo)', error_kind: 'timeout', status: 'degraded', latency_ms: 8000, checked_at: ago(140) },
        ],
        deposits: { pending: 1, stale_pending: 0 },
        proposals: { pending: 1 },
        payments: { in_progress: 1 },
        treasury: { balance: 380, minimum_reserve: 50 },
        workers: [
          { worker: 'provider-health-monitor', last_run_at: ago(0), last_success_at: ago(0), last_error_at: null, last_error: null, last_duration_ms: 420, runs: 4000, failures: 1 },
          { worker: 'sync-order-status', last_run_at: ago(0), last_success_at: ago(0), last_error_at: null, last_error: null, last_duration_ms: 880, runs: 4000, failures: 0 },
          { worker: 'sync-catalog', last_run_at: ago(180), last_success_at: ago(180), last_error_at: null, last_error: null, last_duration_ms: 9100, runs: 40, failures: 0 },
        ],
        cron: [
          { name: 'provider-health-monitor', schedule: '* * * * *', active: true, last_run_at: ago(0), last_status: 'succeeded', last_success_at: ago(0), runs: checks, failed_runs: 0 },
          { name: 'sync-order-status', schedule: '* * * * *', active: true, last_run_at: ago(0), last_status: 'succeeded', last_success_at: ago(0), runs: checks, failed_runs: 0 },
          { name: 'sync-catalog', schedule: '0 */6 * * *', active: true, last_run_at: ago(180), last_status: 'succeeded', last_success_at: ago(180), runs: 4, failed_runs: 0 },
          // the demo shows a late job: the reconciliation detector has not run for 19 minutes
          { name: 'sync-reconciliation-cases', schedule: '*/5 * * * *', active: true, last_run_at: ago(19), last_status: 'succeeded', last_success_at: ago(19), runs: hours * 12, failed_runs: 0 },
        ],
        cron_error: null,
      }
      return buildSystemHealth(raw, now, 41)
    },
  }
}

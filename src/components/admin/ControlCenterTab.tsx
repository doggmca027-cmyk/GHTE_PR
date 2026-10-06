import { useState } from 'react'
import { AlertCircle, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { haptic } from '@/lib/haptics'
import { timeAgo } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { getPlatformSettings, updatePlatformSettings } from '@/services/api/admin'
import type { PlatformSettingsPatch, PlatformSettingsView } from '@/types/admin'

type SwitchKey = 'orders' | 'payments' | 'maintenance'

interface SwitchSpec {
  key: SwitchKey
  title: string
  /** What being "on" means and what happens when it is stopped. */
  on: string
  off: string
  danger?: boolean
}

const SWITCHES: SwitchSpec[] = [
  { key: 'orders', title: 'Global Orders', on: 'Customers can place new orders.', off: 'New orders are refused. Orders already placed keep being processed.' },
  { key: 'payments', title: 'Global Payments', on: 'Customers can start new deposits.', off: 'New deposits are refused. Deposits already paid on-chain are still credited.' },
  { key: 'maintenance', title: 'Maintenance Mode', on: 'The platform is under maintenance: orders AND deposits are refused for everyone.', off: 'Off. The platform runs normally.', danger: true },
]

/** Whether the *service* is running for this switch (maintenance is "running" when it is OFF). */
function running(key: SwitchKey, s: PlatformSettingsView): boolean {
  return key === 'orders' ? s.globalOrdersEnabled : key === 'payments' ? s.globalPaymentsEnabled : !s.maintenanceMode
}

function patchFor(key: SwitchKey, turnOn: boolean): PlatformSettingsPatch {
  return key === 'orders' ? { ordersEnabled: turnOn } : key === 'payments' ? { paymentsEnabled: turnOn } : { maintenanceMode: turnOn }
}

export function ControlCenterTab({ session }: { session: AuthSession }) {
  const { data, error, loading, reload } = useLoader(() => getPlatformSettings(session), [session.token, session.isMock])
  const [busy, setBusy] = useState<SwitchKey | null>(null)
  const [confirming, setConfirming] = useState<SwitchKey | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  if (!data && loading) return <div className="h-[200px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />
  if (!data) {
    return (
      <Card className="space-y-3 text-center">
        <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
        <p className="text-sm font-medium text-content-secondary">{error ?? 'Could not load the controls.'}</p>
        <Button className="w-full" onClick={() => void reload()}>Retry</Button>
      </Card>
    )
  }

  async function apply(spec: SwitchSpec, turnOn: boolean) {
    setBusy(spec.key)
    setConfirming(null)
    setMessage(null)
    try {
      await updatePlatformSettings(session, patchFor(spec.key, turnOn))
      haptic.success()
      setMessage({ kind: 'ok', text: `${spec.title}: ${spec.key === 'maintenance' ? (turnOn ? 'ON' : 'OFF') : (turnOn ? 'enabled' : 'stopped')}.` })
    } catch (e) {
      haptic.error()
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Could not save.' })
    } finally {
      setBusy(null)
      await reload() // always show what the server really has
    }
  }

  return (
    <div className="space-y-3">
      {data.maintenanceMode && (
        <div role="alert" className="flex items-start gap-2.5 rounded-2xl bg-rose-600 px-3.5 py-3 text-sm font-bold text-white">
          <AlertTriangle size={18} strokeWidth={2} className="mt-0.5 shrink-0" />
          Maintenance mode is ON. No customer can place orders or start deposits.
        </div>
      )}
      <p className="rounded-2xl bg-brand-light/60 px-3.5 py-2.5 text-[13px] font-medium text-brand-text">
        Emergency controls act at once and are enforced on the server for every request. Stopping a switch asks you to confirm.
      </p>
      {message && (
        <p role="status" className={cn('rounded-2xl px-3.5 py-2.5 text-[13px] font-medium', message.kind === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}>
          {message.text}
        </p>
      )}

      {SWITCHES.map((spec) => {
        const isRunning = running(spec.key, data)
        // The switch is "on" when the thing it names is active: orders/payments flowing, maintenance engaged.
        const checked = spec.key === 'maintenance' ? data.maintenanceMode : isRunning
        const stopping = spec.key === 'maintenance' ? !data.maintenanceMode : isRunning // the click that would pause or engage
        return (
          <article
            key={spec.key}
            className={cn(
              'rounded-3xl border p-4 shadow-card',
              spec.danger ? (data.maintenanceMode ? 'border-rose-400 bg-rose-50' : 'border-rose-200 bg-white') : 'border-blue-100/70 bg-white',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className={cn('text-[15px] font-bold leading-snug', spec.danger ? 'text-rose-700' : 'text-content-primary')}>{spec.title}</h3>
                <p className="mt-1 text-xs text-content-secondary">{checked ? spec.on : spec.off}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={checked}
                aria-label={spec.title}
                disabled={busy !== null}
                onClick={() => {
                  haptic.select()
                  if (stopping && confirming !== spec.key) setConfirming(spec.key)
                  else void apply(spec, spec.key === 'maintenance' ? !data.maintenanceMode : !isRunning)
                }}
                className={cn(
                  'relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50',
                  spec.danger ? (checked ? 'bg-rose-600' : 'bg-slate-300') : checked ? 'bg-brand' : 'bg-slate-300',
                )}
              >
                <span className={cn('absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform', checked && 'translate-x-5')} />
              </button>
            </div>
            {confirming === spec.key && (
              <div className="mt-3 flex items-center gap-2 rounded-2xl bg-amber-50 px-3 py-2.5">
                <p className="flex-1 text-xs font-semibold text-amber-800">
                  {spec.key === 'maintenance' ? 'Block ALL orders and deposits for everyone?' : spec.key === 'orders' ? 'Stop all new orders?' : 'Stop all new deposits?'}
                </p>
                <button type="button" onClick={() => void apply(spec, spec.key === 'maintenance')} className="h-8 rounded-full bg-rose-600 px-3 text-xs font-bold text-white active:scale-95">Confirm</button>
                <button type="button" onClick={() => setConfirming(null)} className="h-8 rounded-full bg-white px-3 text-xs font-semibold text-content-secondary active:scale-95">Cancel</button>
              </div>
            )}
          </article>
        )
      })}

      <p className="px-1 text-xs text-content-secondary">{data.updatedAt ? `Last changed ${timeAgo(data.updatedAt)}.` : 'Never changed.'}</p>
    </div>
  )
}

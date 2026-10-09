import { useState } from 'react'
import { AlertCircle, Check, Plus } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { describePromo, parsePromoForm, type PromoForm } from '@/lib/promo-view'
import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { createPromo, listPromos, setPromoActive } from '@/services/api/admin'
import type { PromoView } from '@/types/admin'

const EMPTY: PromoForm = { code: '', type: 'percentage', value: '', maxUses: '', expires: '' }
const fieldCls = 'mt-1 w-full rounded-xl border border-blue-100/70 bg-white px-3 py-2.5 text-sm font-medium outline-none focus:border-brand'

export function PromosTab({ session }: { session: AuthSession }) {
  const { data, error, loading, reload } = useLoader(() => listPromos(session), [session.token, session.isMock])
  const [form, setForm] = useState<PromoForm>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const parsed = parsePromoForm(form)

  async function create() {
    if ('error' in parsed) return
    setBusy(true); setMessage(null)
    try {
      const promo = await createPromo(session, parsed.input)
      haptic.success()
      setMessage({ kind: 'ok', text: `Промокод ${promo.code} создан.` })
      setForm(EMPTY)
      await reload()
    } catch (e) {
      haptic.error()
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Не удалось создать промокод.' })
    } finally {
      setBusy(false)
    }
  }

  async function toggle(p: PromoView) {
    setBusy(true); setMessage(null)
    try {
      await setPromoActive(session, p.id, !p.isActive)
      haptic.success()
      setMessage({ kind: 'ok', text: `Промокод ${p.code} ${p.isActive ? 'выключен' : 'включён'}.` })
      await reload()
    } catch (e) {
      haptic.error()
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Не удалось сохранить.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="rounded-2xl bg-brand-light/60 px-3.5 py-2.5 text-[13px] font-medium text-brand-text">
        Промокод даёт скидку на заказ. Скидка никогда не опускает цену ниже закупки плюс минимальная маржа, поэтому в убыток он продать не может. Один человек использует один код один раз.
      </p>
      {message && (
        <p role={message.kind === 'ok' ? 'status' : 'alert'} className={cn('rounded-2xl px-3.5 py-2.5 text-[13px] font-medium', message.kind === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}>
          {message.text}
        </p>
      )}

      <Card className="space-y-3 p-4">
        <h3 className="text-[15px] font-bold text-content-primary">Новый промокод</h3>
        <label className="block text-xs font-bold text-content-primary">
          Код (пусто — придумаем сами)
          <input value={form.code} maxLength={32} autoCapitalize="characters" placeholder="например SUMMER10"
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') })} className={fieldCls} />
        </label>
        <div role="radiogroup" aria-label="Тип скидки" className="flex gap-2">
          {(['percentage', 'fixed'] as const).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={form.type === t} onClick={() => setForm({ ...form, type: t })}
              className={cn('h-10 flex-1 rounded-2xl text-sm font-semibold', form.type === t ? 'bg-brand text-white' : 'bg-surface-sub text-content-secondary')}>
              {t === 'percentage' ? 'Процент' : 'Сумма в $'}
            </button>
          ))}
        </div>
        <label className="block text-xs font-bold text-content-primary">
          {form.type === 'percentage' ? 'Скидка (%, от 1 до 90)' : 'Скидка (USD)'}
          <input value={form.value} inputMode="decimal" onChange={(e) => setForm({ ...form, value: e.target.value.replace(/[^\d.]/g, '') })} className={fieldCls} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs font-bold text-content-primary">
            Сколько раз (пусто — без лимита)
            <input value={form.maxUses} inputMode="numeric" onChange={(e) => setForm({ ...form, maxUses: e.target.value.replace(/\D/g, '') })} className={fieldCls} />
          </label>
          <label className="block text-xs font-bold text-content-primary">
            Действует до
            <input type="date" value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} className={fieldCls} />
          </label>
        </div>
        {'error' in parsed && form.value !== '' && <p role="alert" className="text-xs font-semibold text-rose-600">{parsed.error}</p>}
        <Button className="h-11 w-full text-sm" disabled={'error' in parsed || busy} onClick={() => void create()}>
          <Plus size={16} strokeWidth={2} /> Создать промокод
        </Button>
      </Card>

      {!data && loading && [0, 1].map((i) => <div key={i} className="h-[90px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />)}
      {!data && !loading && (
        <Card className="space-y-3 text-center">
          <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
          <p className="text-sm font-medium text-content-secondary">{error ?? 'Не удалось загрузить промокоды.'}</p>
          <Button className="w-full" onClick={() => void reload()}>Повторить</Button>
        </Card>
      )}
      {data && data.length === 0 && <Card className="p-4 text-sm text-content-secondary">Промокодов пока нет.</Card>}
      {data?.map((p) => {
        const info = describePromo(p)
        return (
          <article key={p.id} className={cn('rounded-3xl border bg-white p-4 shadow-card', info.live ? 'border-blue-100/70' : 'border-slate-200 opacity-80')}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-mono text-[15px] font-bold tracking-wide text-content-primary">{p.code}</h3>
                <p className="mt-0.5 text-xs text-content-secondary">{info.discount} · {info.usage}</p>
                <p className={cn('mt-1 text-xs font-semibold', info.live ? 'text-emerald-600' : 'text-amber-600')}>{info.status}</p>
              </div>
              <button type="button" role="switch" aria-checked={p.isActive} aria-label={`${p.isActive ? 'Выключить' : 'Включить'} ${p.code}`} disabled={busy}
                onClick={() => { haptic.select(); void toggle(p) }}
                className={cn('relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50', p.isActive ? 'bg-brand' : 'bg-slate-300')}>
                <span className={cn('absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform', p.isActive && 'translate-x-5')} />
              </button>
            </div>
          </article>
        )
      })}
      {data && data.length > 0 && <p className="flex items-center justify-center gap-1 pt-1 text-xs text-content-secondary"><Check size={12} strokeWidth={2} /> Показаны последние {Math.min(data.length, 200)} кодов</p>}
    </div>
  )
}

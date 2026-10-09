import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, Pencil, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useLoader } from '@/hooks/useLoader'
import { LOW_MARGIN_PERCENT, pricingHealth, usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { getPricing, setMargin } from '@/services/api/admin'
import { fetchCategories, fetchPlatforms } from '@/services/api/services'
import { calculateCustomerRate } from '../../../supabase/functions/_shared/price-engine.ts'
import type { MarginRuleInput, PricingRow } from '@/types/admin'

const PAGE = 30
type Message = { kind: 'ok' | 'error'; text: string }

const parseMarkup = (draft: string): number | null => (/^\d+(\.\d{1,2})?$/.test(draft.trim()) && Number(draft) <= 100_000 ? Number(draft) : null)
const fieldCls = 'mt-1 w-full rounded-xl border border-blue-100/70 bg-white px-3 py-2.5 text-sm font-medium outline-none focus:border-brand'

export function PricingTab({ session }: { session: AuthSession }) {
  const [message, setMessage] = useState<Message | null>(null)
  const [version, setVersion] = useState(0)

  return (
    <div className="space-y-3">
      <p className="rounded-2xl bg-brand-light/60 px-3.5 py-2.5 text-[13px] font-medium text-brand-text">
        Наценка считается от закупочной цены провайдера (самого дешёвого здорового предложения). Побеждает самое узкое правило: услуга, затем категория, затем платформа, затем «все услуги».
        После сохранения цены пересчитываются сразу.
      </p>
      {message?.text && (
        <p role={message.kind === 'ok' ? 'status' : 'alert'} className={cn('rounded-2xl px-3.5 py-2.5 text-[13px] font-medium', message.kind === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}>
          {message.text}
        </p>
      )}
      <BulkMarginCard session={session} onDone={(m) => { setMessage(m); if (m.kind === 'ok') setVersion((v) => v + 1) }} />
      <ServiceGrid session={session} version={version} onMessage={setMessage} />
    </div>
  )
}

// ---- Markup for everything / a platform / a category ----------------------------------------------------

function BulkMarginCard({ session, onDone }: { session: AuthSession; onDone: (m: Message) => void }) {
  const [scope, setScope] = useState<'all' | 'platform' | 'category'>('all')
  const [platform, setPlatform] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [type, setType] = useState<'percentage' | 'fixed'>('percentage')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const platforms = useLoader(() => fetchPlatforms(session), [session.token, session.isMock])
  const categories = useLoader(() => fetchCategories(session), [session.token, session.isMock])
  const platformCategories = useMemo(() => (categories.data ?? []).filter((c) => c.platform === platform), [categories.data, platform])

  const value = parseMarkup(draft)
  const target = scope === 'all' ? 'все услуги' : scope === 'platform' ? (platforms.data?.find((p) => p.slug === platform)?.name ?? '') : (platformCategories.find((c) => c.id === categoryId)?.name ?? '')
  const ready = value !== null && (scope === 'all' || (scope === 'platform' && platform !== '') || (scope === 'category' && categoryId !== ''))
  const preview = value !== null ? calculateCustomerRate(1, [{ id: 'preview', type, value, priority: 0 }]) : null

  async function save() {
    if (!ready || value === null) return
    const input: MarginRuleInput = { type, value, ...(scope === 'platform' ? { platform } : scope === 'category' ? { categoryId } : {}) }
    setBusy(true)
    try {
      const { repriced } = await setMargin(session, input)
      haptic.success()
      onDone({ kind: 'ok', text: `Наценка сохранена (${target}): пересчитано цен — ${repriced}.` })
      setDraft('')
    } catch (e) {
      haptic.error()
      onDone({ kind: 'error', text: e instanceof Error ? e.message : 'Не удалось сохранить.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-[15px] font-bold text-content-primary">Наценка на группу услуг</h3>
      <div role="radiogroup" aria-label="На что действует наценка" className="flex gap-2">
        {([['all', 'Все услуги'], ['platform', 'Платформа'], ['category', 'Категория']] as const).map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={scope === id} onClick={() => setScope(id)}
            className={cn('h-10 flex-1 rounded-2xl text-[13px] font-semibold', scope === id ? 'bg-brand text-white' : 'bg-surface-sub text-content-secondary')}>
            {label}
          </button>
        ))}
      </div>
      {scope !== 'all' && (
        <label className="block text-xs font-bold text-content-primary">
          Платформа
          <select value={platform} onChange={(e) => { setPlatform(e.target.value); setCategoryId('') }} className={fieldCls}>
            <option value="">Выберите платформу</option>
            {(platforms.data ?? []).map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </select>
        </label>
      )}
      {scope === 'category' && (
        <label className="block text-xs font-bold text-content-primary">
          Категория
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={platform === ''} className={fieldCls}>
            <option value="">{platform === '' ? 'Сначала выберите платформу' : platformCategories.length === 0 ? 'В этой платформе нет категорий' : 'Выберите категорию'}</option>
            {platformCategories.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.count ?? 0})</option>)}
          </select>
        </label>
      )}
      <div role="radiogroup" aria-label="Тип наценки" className="flex gap-2">
        {(['percentage', 'fixed'] as const).map((t) => (
          <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => setType(t)}
            className={cn('h-10 flex-1 rounded-2xl text-sm font-semibold', type === t ? 'bg-brand text-white' : 'bg-surface-sub text-content-secondary')}>
            {t === 'percentage' ? 'Процент' : 'Фиксированная'}
          </button>
        ))}
      </div>
      <label className="block text-xs font-bold text-content-primary">
        {type === 'fixed' ? 'Наценка (USD за 1000)' : 'Наценка (%)'}
        <input value={draft} inputMode="decimal" placeholder={type === 'fixed' ? 'например 0.50' : 'например 150'} aria-invalid={draft !== '' && value === null}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ''))}
          className={cn(fieldCls, draft !== '' && value === null && 'border-rose-300')} />
      </label>
      <p className="text-xs font-medium text-content-secondary">
        {preview !== null ? `Услуга с закупкой $1.00 за 1000 будет продаваться за ${usd(preview)}.` : 'Число от 0 до 100000, до 2 знаков после точки. Цена никогда не опускается ниже закупки + минимальной маржи.'}
      </p>
      <Button className="h-11 w-full text-sm" disabled={!ready || busy} onClick={() => void save()}>
        <Check size={16} strokeWidth={2} /> {busy ? 'Сохраняем…' : 'Применить наценку'}
      </Button>
    </Card>
  )
}

// ---- Services, one by one --------------------------------------------------------------------------------

function ServiceGrid({ session, version, onMessage }: { session: AuthSession; version: number; onMessage: (m: Message) => void }) {
  const [search, setSearch] = useState('')
  const [platform, setPlatform] = useState('')
  const [rows, setRows] = useState<PricingRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<PricingRow | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const latest = useRef(0)
  const platforms = useLoader(() => fetchPlatforms(session), [session.token, session.isMock])

  async function load(offset: number) {
    const mine = ++latest.current
    setLoading(true); setError(null)
    try {
      const page = await getPricing(session, { search, platform: platform || undefined, offset, limit: PAGE })
      if (mine !== latest.current) return
      setRows((prev) => (offset === 0 ? page.rows : [...prev, ...page.rows]))
      setTotal(page.total)
    } catch (e) {
      if (mine === latest.current) setError(e instanceof Error ? e.message : 'Не удалось загрузить цены.')
    } finally {
      if (mine === latest.current) setLoading(false)
    }
  }

  // a new search or filter starts from the first page (typing is debounced); a saved margin reloads the page the admin is looking at
  useEffect(() => {
    const t = setTimeout(() => void load(0), search === '' ? 0 : 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, platform, version, reloadKey, session.token, session.isMock])

  return (
    <div className="space-y-3">
      <h3 className="pt-1 text-[15px] font-bold text-content-primary">Цены по услугам</h3>
      <div className="flex gap-2">
        <label className="relative block flex-1">
          <Search size={16} strokeWidth={1.75} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-secondary" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по названию или категории" aria-label="Поиск услуги"
            className="w-full rounded-xl border border-blue-100/70 bg-white py-2.5 pl-9 pr-3 text-sm font-medium outline-none focus:border-brand" />
        </label>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Платформа" className="w-36 rounded-xl border border-blue-100/70 bg-white px-2 py-2.5 text-sm font-medium outline-none focus:border-brand">
          <option value="">Все</option>
          {(platforms.data ?? []).map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
        </select>
      </div>

      {error && rows.length === 0 && (
        <Card className="space-y-3 text-center">
          <AlertCircle size={28} strokeWidth={1.75} className="mx-auto text-brand" />
          <p className="text-sm font-medium text-content-secondary">{error}</p>
          <Button className="w-full" onClick={() => setReloadKey((k) => k + 1)}>Повторить</Button>
        </Card>
      )}
      {!error && !loading && rows.length === 0 && <Card className="p-4 text-sm text-content-secondary">Услуг не найдено.</Card>}
      {rows.map((row) => <PricingCard key={row.serviceId} row={row} onEdit={() => { haptic.tap(); onMessage({ kind: 'ok', text: '' }); setEditing(row) }} />)}
      {loading && rows.length === 0 && [0, 1, 2].map((i) => <div key={i} className="h-[130px] animate-pulse rounded-3xl border border-blue-100/70 bg-white/80" />)}
      {rows.length > 0 && rows.length < total && (
        <Button className="w-full" disabled={loading} onClick={() => void load(rows.length)}>
          {loading ? 'Загружаем…' : `Показать ещё (${total - rows.length})`}
        </Button>
      )}

      {editing && (
        <MarginModal
          row={editing}
          onClose={() => setEditing(null)}
          onSave={async (type, value) => {
            try {
              await setMargin(session, { serviceId: editing.serviceId, type, value })
            } catch (e) {
              haptic.error()
              throw e
            }
            haptic.success()
            onMessage({ kind: 'ok', text: `${editing.name}: наценка обновлена.` })
            setEditing(null)
            setReloadKey((k) => k + 1)
          }}
        />
      )}
    </div>
  )
}

function PricingCard({ row, onEdit }: { row: PricingRow; onEdit: () => void }) {
  const health = pricingHealth(row)
  const bad = health === 'loss' || health === 'low'
  return (
    <article className={cn('rounded-3xl border bg-white p-4 shadow-card', health === 'loss' ? 'border-rose-300' : health === 'low' ? 'border-amber-300' : 'border-blue-100/70')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold leading-snug text-content-primary">{row.name}</h3>
          <p className="mt-0.5 text-xs text-content-secondary">{row.platform} · {row.category}</p>
        </div>
        <button type="button" onClick={onEdit} className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-brand-light px-3.5 text-[13px] font-bold text-brand-text active:scale-95">
          <Pencil size={14} strokeWidth={1.75} /> Наценка
        </button>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div><dt className="text-xs text-content-secondary">Закупка</dt><dd className="font-bold text-content-primary">{row.bestCost === null ? 'Нет предложений' : usd(row.bestCost)}</dd></div>
        <div><dt className="text-xs text-content-secondary">Цена</dt><dd className="font-bold text-content-primary">{usd(row.customerRate)}</dd></div>
        <div>
          <dt className="text-xs text-content-secondary">Прибыль</dt>
          <dd className={cn('font-bold', health === 'loss' ? 'text-rose-600' : bad ? 'text-amber-600' : health === 'unknown' ? 'text-content-secondary' : 'text-emerald-600')}>
            {row.marginAbsolute === null || row.marginPercent === null ? '-' : `${row.marginAbsolute < 0 ? '-' : ''}${usd(Math.abs(row.marginAbsolute))} (${row.marginPercent.toFixed(1)}%)`}
          </dd>
        </div>
      </dl>
      {health === 'loss' && <p role="alert" className="mt-2 text-xs font-semibold text-rose-600">Продаётся ниже закупки.</p>}
      {health === 'low' && <p role="alert" className="mt-2 text-xs font-semibold text-amber-600">Маржа меньше {LOW_MARGIN_PERCENT}%.</p>}
    </article>
  )
}

function MarginModal({ row, onClose, onSave }: { row: PricingRow; onClose: () => void; onSave: (type: 'fixed' | 'percentage', value: number) => Promise<void> }) {
  const [type, setType] = useState<'fixed' | 'percentage'>('percentage')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const parsed = parseMarkup(draft)
  const valid = parsed !== null
  // Preview on the best current cost; the server reprices from the primary provider rate, so this is indicative.
  const preview = valid && row.bestCost !== null ? calculateCustomerRate(row.bestCost, [{ id: 'preview', type, value: parsed, priority: 0 }]) : null

  return (
    <div role="dialog" aria-modal="true" aria-label={`Наценка для ${row.name}`} className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
      <div className="w-full max-w-md space-y-3 rounded-3xl bg-white p-4 shadow-card">
        <h3 className="text-[15px] font-bold text-content-primary">{row.name}</h3>
        <div role="radiogroup" aria-label="Тип наценки" className="flex gap-2">
          {(['percentage', 'fixed'] as const).map((t) => (
            <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => setType(t)}
              className={cn('h-10 flex-1 rounded-2xl text-sm font-semibold', type === t ? 'bg-brand text-white' : 'bg-surface-sub text-content-secondary')}>
              {t === 'percentage' ? 'Процент' : 'Фиксированная'}
            </button>
          ))}
        </div>
        <label className="block text-xs font-bold text-content-primary">
          {type === 'fixed' ? 'Наценка (USD за 1000)' : 'Наценка (%)'}
          <input value={draft} inputMode="decimal" autoFocus onChange={(e) => setDraft(e.target.value.replace(/[^\d.]/g, ''))} aria-invalid={draft !== '' && !valid}
            className={cn(fieldCls, draft !== '' && !valid && 'border-rose-300')} />
        </label>
        <p className="text-xs font-medium text-content-secondary">
          {preview !== null ? `При текущей закупке (${usd(row.bestCost ?? 0)}) цена будет ${usd(preview)}.` : 'Число от 0 до 100000, до 2 знаков после точки.'}
        </p>
        {err && <p role="alert" className="text-xs font-semibold text-rose-600">{err}</p>}
        <div className="flex gap-2">
          <Button className="h-11 flex-1 text-sm" disabled={!valid || busy}
            onClick={async () => {
              if (parsed === null) return
              setBusy(true); setErr(null)
              try { await onSave(type, parsed) } catch (e) { setErr(e instanceof Error ? e.message : 'Не удалось сохранить.'); setBusy(false) }
            }}>
            <Check size={16} strokeWidth={2} /> Сохранить
          </Button>
          <button type="button" onClick={onClose} className="flex h-11 flex-1 items-center justify-center gap-1 rounded-2xl bg-surface-sub text-sm font-semibold text-content-secondary active:scale-95">
            <X size={16} strokeWidth={2} /> Отмена
          </button>
        </div>
      </div>
    </div>
  )
}

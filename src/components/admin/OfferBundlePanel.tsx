import { useState } from 'react'
import { Link2, Loader2, Search, Unlink } from 'lucide-react'
import { usd } from '@/lib/admin-view'
import { haptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { linkByExternalId, listBundle, searchBundleServices, unlinkOffer } from '@/services/api/admin-catalog-mapping'
import type { AdminProvider } from '@/types/admin-providers'
import type { BundleSearchItem, BundleView, OfferBlock } from '@/types/catalog-mapping'

export const BLOCK_LABEL: Record<OfferBlock, string> = {
  anomaly: 'провайдер прислал некорректные данные, оффер заморожен до исправления',
  offer_off: 'оффер выключен',
  panel_removed: 'провайдер убрал эту услугу',
  provider_off: 'провайдер выключен',
  routing_off: 'у провайдера выключена маршрутизация',
  unhealthy: 'провайдер сейчас недоступен',
  above_price: 'себестоимость выше цены услуги',
}

/**
 * Bundles: sell one storefront service through several providers. Pick a service, type a provider's own service number, link it.
 * Orders go to the cheapest provider that can take them (the rest are the failover); the storefront price is built on the most
 * expensive usable offer, so every cheaper provider is margin.
 */
export function OfferBundlePanel({ session, providers }: { session: AuthSession; providers: AdminProvider[] }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<BundleSearchItem[] | null>(null)
  const [bundle, setBundle] = useState<BundleView | null>(null)
  const [providerId, setProviderId] = useState('')
  const [externalId, setExternalId] = useState('')
  const [busy, setBusy] = useState<'search' | 'open' | 'link' | string | null>(null)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const active = providers.filter((p) => p.isActive)

  const fail = (e: unknown) => { haptic.error(); setNote({ kind: 'error', text: e instanceof Error ? e.message : 'Не удалось выполнить.' }) }

  async function search() {
    if (!query.trim()) return
    setBusy('search'); setNote(null)
    try { setResults(await searchBundleServices(session, query.trim())) } catch (e) { fail(e) } finally { setBusy(null) }
  }
  async function open(id: string) {
    setBusy('open'); setNote(null)
    try { setBundle(await listBundle(session, id)); setResults(null) } catch (e) { fail(e) } finally { setBusy(null) }
  }
  async function link() {
    if (!bundle || !providerId || !externalId.trim()) return
    setBusy('link'); setNote(null)
    try {
      const r = await linkByExternalId(session, { serviceId: bundle.service.id, providerId, externalServiceId: externalId.trim() })
      haptic.success()
      setBundle({ service: r.service, price: r.price, offers: r.offers })
      setExternalId('')
      setNote({ kind: 'ok', text: `Привязано: #${r.link.panel.externalServiceId} «${r.link.panel.name}», себестоимость ${usd(r.link.panel.costPer1000)} за 1000.` + (r.link.price.changed ? ` Цена услуги: ${usd(r.link.price.currentRate)} → ${usd(r.link.price.newRate)}.` : '') })
    } catch (e) { fail(e) } finally { setBusy(null) }
  }
  async function unlink(offerId: string) {
    setBusy(offerId); setNote(null)
    try { setBundle(await unlinkOffer(session, offerId)); haptic.success() } catch (e) { fail(e) } finally { setBusy(null) }
  }

  const cheapest = bundle?.offers.find((o) => o.rank === 1)
  const margin = bundle && cheapest ? bundle.service.customerRatePer1000 - cheapest.costPer1000 : null

  return (
    <section aria-label="Связки провайдеров" className="space-y-3 rounded-3xl border border-blue-100/70 bg-surface p-4 shadow-card">
      <div>
        <h3 className="text-[15px] font-bold text-content-primary">Связки провайдеров</h3>
        <p className="mt-1 text-xs text-content-secondary">
          Одна услуга витрины — несколько провайдеров. Заказ уходит самому дешёвому доступному, остальные — запасные. Цена витрины считается от самого дорогого оффера связки, поэтому дешёвые провайдеры дают маржу.
        </p>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); void search() }} className="flex gap-2">
        <label className="relative flex-1">
          <span className="sr-only">Найти услугу витрины</span>
          <Search size={15} strokeWidth={1.75} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={100} placeholder="Название или ID услуги" className="h-10 w-full rounded-xl border border-blue-100/70 bg-surface pl-9 pr-3 text-sm outline-none focus:border-brand" />
        </label>
        <button type="submit" disabled={busy === 'search' || !query.trim()} className="h-10 rounded-xl bg-brand px-4 text-sm font-bold text-white disabled:opacity-50">
          {busy === 'search' ? <Loader2 size={16} className="animate-spin" /> : 'Найти'}
        </button>
      </form>

      {results && (
        <ul className="max-h-60 space-y-1 overflow-y-auto" aria-label="Найденные услуги">
          {results.length === 0 && <li className="text-xs text-content-secondary">Ничего не найдено.</li>}
          {results.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => void open(s.id)} className="w-full rounded-xl bg-surface-sub px-3 py-2 text-left text-[13px] active:scale-[0.99]">
                <span className="line-clamp-1 font-semibold text-content-primary">{s.name}</span>
                <span className="text-xs text-content-secondary">{s.platform} · {usd(s.customerRatePer1000)} за 1000 · офферов: {s.offers}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {bundle && (
        <div className="space-y-3">
          <div className="rounded-2xl bg-surface-sub p-3 text-[13px]">
            <p className="font-bold text-content-primary">{bundle.service.name}</p>
            <p className="mt-1 text-xs text-content-secondary">
              Цена витрины {usd(bundle.service.customerRatePer1000)} за 1000
              {bundle.price.basisCost !== null && ` · считается от ${usd(bundle.price.basisCost)}`}
              {margin !== null && ` · маржа с первого провайдера ${usd(margin)}`}
            </p>
          </div>

          <ol className="space-y-1.5" aria-label="Офферы в порядке маршрутизации">
            {bundle.offers.length === 0 && <li className="text-xs text-content-secondary">У услуги пока нет офферов.</li>}
            {bundle.offers.map((o) => (
              <li key={o.offerId} className={cn('flex items-start justify-between gap-2 rounded-xl border px-3 py-2 text-[13px]', o.rank ? 'border-emerald-200' : 'border-blue-100/70 opacity-80')}>
                <div className="min-w-0">
                  <p className="font-semibold text-content-primary">
                    {o.rank ? <span className="mr-1.5 rounded-full bg-emerald-50 px-1.5 text-[11px] font-bold text-emerald-700">#{o.rank}</span> : null}
                    {o.providerName} · услуга №{o.externalServiceId}
                  </p>
                  <p className="text-xs text-content-secondary">{usd(o.costPer1000)} за 1000 · {o.minQuantity}–{o.maxQuantity} · баланс {usd(o.providerBalance)}</p>
                  {o.blockedBy && <p className="text-xs font-semibold text-amber-700">Не получает заказы: {BLOCK_LABEL[o.blockedBy]}</p>}
                </div>
                {o.blockedBy !== 'offer_off' && (
                  <button type="button" aria-label={`Отвязать ${o.providerName} №${o.externalServiceId}`} disabled={busy === o.offerId} onClick={() => void unlink(o.offerId)} className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-surface-sub px-2.5 text-xs font-bold text-content-secondary disabled:opacity-50">
                    <Unlink size={13} strokeWidth={1.75} /> Отвязать
                  </button>
                )}
              </li>
            ))}
          </ol>

          <form onSubmit={(e) => { e.preventDefault(); void link() }} className="space-y-2 rounded-2xl border border-dashed border-blue-100 p-3">
            <p className="text-xs font-bold text-content-primary">Привязать услугу провайдера</p>
            <div className="flex gap-2">
              <select aria-label="Провайдер" value={providerId} onChange={(e) => setProviderId(e.target.value)} className="h-10 min-w-0 flex-1 rounded-xl border border-blue-100/70 bg-surface px-2 text-sm">
                <option value="">Провайдер…</option>
                {active.map((p) => <option key={p.id} value={p.id}>{p.name}{p.catalogMode === 'linked_only' ? '' : ' (весь каталог)'}</option>)}
              </select>
              <input aria-label="ID услуги у провайдера" value={externalId} onChange={(e) => setExternalId(e.target.value.replace(/\s/g, ''))} maxLength={64} inputMode="numeric" placeholder="ID услуги" className="h-10 w-28 rounded-xl border border-blue-100/70 bg-surface px-3 text-sm outline-none focus:border-brand" />
            </div>
            <button type="submit" disabled={busy === 'link' || !providerId || !externalId.trim()} className="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-brand text-sm font-bold text-white disabled:opacity-50">
              {busy === 'link' ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} strokeWidth={1.75} />} Привязать
            </button>
            <p className="text-[11px] text-content-secondary">Цена и лимиты берутся у провайдера в момент привязки; цена услуги сразу пересчитывается.</p>
          </form>
        </div>
      )}

      {note && <p role={note.kind === 'error' ? 'alert' : 'status'} className={cn('rounded-xl px-3 py-2 text-xs font-semibold', note.kind === 'error' ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700')}>{note.text}</p>}
    </section>
  )
}

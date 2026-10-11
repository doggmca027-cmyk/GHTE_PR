// Texts and state of the Smart Arbitrage card (admin "Провайдеры" tab). Pure, so the wording is unit-tested.
import { plural } from '@/lib/admin-view'
import type { ArbitrageStatus } from '@/types/admin-providers'

export type ArbitrageMode = 'off' | 'partial' | 'on'

export interface ArbitrageView {
  mode: ArbitrageMode
  title: string
  status: string
  /** Shown when there is something to switch on (mode off or partial). */
  enableLabel: string | null
  /** Shown when there is something to switch off (mode on or partial). */
  disableLabel: string | null
  /** Donors the switch can turn on: active, with an API key. */
  eligible: number
}

const networks = (n: number) => `${n} ${plural(n, ['сеть', 'сети', 'сетей'])}`

export function arbitrageView(s: ArbitrageStatus): ArbitrageView {
  const eligible = s.donors.filter((d) => d.isActive && d.hasApiKey)
  const on = s.donors.filter((d) => d.routingEnabled)
  const offers = s.donors.reduce((sum, d) => sum + d.activeOffers, 0)
  const primary = s.primary.filter((p) => p.routingEnabled).map((p) => p.name)
  const primaryText = primary.length ? primary.join(', ') : 'нет основной сети'
  const mode: ArbitrageMode = on.length === 0 ? 'off' : eligible.every((d) => d.routingEnabled) ? 'on' : 'partial'

  const title = `Режим Smart Arbitrage (${s.donors.length} ${plural(s.donors.length, ['донорская сеть', 'донорские сети', 'донорских сетей'])} · ${offers} ${plural(offers, ['лучший оффер', 'лучших оффера', 'лучших офферов'])})`
  const status = mode === 'off'
    ? `Активна ${networks(primary.length)} (${primaryText})`
    : mode === 'on'
      ? 'Активен Smart Arbitrage (все сети)'
      : `Smart Arbitrage частично: включено ${on.length} из ${eligible.length} ${plural(eligible.length, ['сети', 'сетей', 'сетей'])}`
  return {
    mode, title, status, eligible: eligible.length,
    enableLabel: mode !== 'on' && eligible.length > 0 ? `Включить все ${networks(eligible.length)} (Лучшие цены)` : null,
    disableLabel: mode !== 'off' ? `Оставить только ${networks(Math.max(primary.length, 1))} (${primaryText})` : null,
  }
}

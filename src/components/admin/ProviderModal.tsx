import { useState } from 'react'
import { Check, KeyRound, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { checkProviderDraft, draftOf, emptyDraft, type ProviderDraft } from '@/lib/provider-form'
import { cn } from '@/lib/utils'
import type { AdminProvider, UpsertProviderRequest } from '@/types/admin-providers'

/**
 * Add (provider = null) or edit a provider through UPSERT_PROVIDER.
 *
 * The API key field is a password input that is never prefilled: the server does not return keys, not even encrypted. On edit
 * an empty field means "keep the current key" (apiKey is left out of the request). The key lives only in this component's state
 * until the request is sent, and it is dropped from state as soon as the request succeeds or the modal closes.
 */
export function ProviderModal({ provider, onClose, onSave }: {
  provider: AdminProvider | null
  onClose: () => void
  onSave: (request: UpsertProviderRequest) => Promise<void>
}) {
  const editing = provider !== null
  const [draft, setDraft] = useState<ProviderDraft>(() => (provider ? draftOf(provider) : emptyDraft()))
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const check = checkProviderDraft(draft, provider)
  const set = (patch: Partial<ProviderDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const show = (field: keyof typeof check.errors) => (touched ? check.errors[field] : undefined)

  async function save() {
    setTouched(true)
    if (!check.request) return
    setBusy(true)
    setErr(null)
    try {
      await onSave(check.request)
    } catch (e) {
      // the message comes from the server and never contains the key
      setErr(e instanceof Error ? e.message : 'Не удалось сохранить.')
      setBusy(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={editing ? `Изменить провайдера ${provider.name}` : 'Добавить провайдера'} className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
      <form
        onSubmit={(e) => { e.preventDefault(); void save() }}
        autoComplete="off"
        className="max-h-[92vh] w-full max-w-md space-y-3 overflow-y-auto rounded-3xl bg-white p-4 shadow-card"
      >
        <h3 className="text-[15px] font-bold text-content-primary">{editing ? `Изменить: ${provider.name}` : 'Добавить провайдера'}</h3>

        {editing && !provider.hasApiKey && (
          <p role="status" className="flex items-start gap-2 rounded-2xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
            <TriangleAlert size={16} strokeWidth={1.75} className="mt-px shrink-0" />
            У этого провайдера ещё нет API-ключа. Пока ключ не сохранён, маршрутизацию включить нельзя.
          </p>
        )}

        <Field label="Название" error={show('name')}>
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} aria-invalid={Boolean(show('name'))} required className={input(show('name'))} />
        </Field>

        <Field label="API URL" error={show('apiUrl')} hint="Адрес должен начинаться с https:// и вести на публичный хост.">
          <input value={draft.apiUrl} onChange={(e) => set({ apiUrl: e.target.value })} type="url" inputMode="url" spellCheck={false} placeholder="https://panel.example.com/api/v2"
            aria-invalid={Boolean(show('apiUrl'))} required className={cn(input(show('apiUrl')), 'font-mono text-[13px]')} />
        </Field>

        <Field
          label="API-ключ"
          error={show('apiKey')}
          hint={editing ? (provider.hasApiKey ? 'Ключ сохранён. Оставьте поле пустым, чтобы не менять его.' : undefined) : 'Можно добавить позже, но без ключа маршрутизацию не включить.'}
        >
          <div className="relative">
            <KeyRound size={16} strokeWidth={1.75} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-secondary" />
            <input
              value={draft.apiKey}
              onChange={(e) => set({ apiKey: e.target.value })}
              type="password"
              name="provider-api-key"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={editing ? 'Пусто — оставить текущий ключ' : 'Вставьте API-ключ провайдера'}
              aria-invalid={Boolean(show('apiKey'))}
              className={cn(input(show('apiKey')), 'pl-9')}
            />
          </div>
        </Field>

        <Field label="Приоритет" error={show('priority')} hint="Чем выше приоритет, тем выше провайдер в списке.">
          <input value={draft.priority} onChange={(e) => set({ priority: e.target.value.replace(/[^\d-]/g, '') })} inputMode="numeric" aria-invalid={Boolean(show('priority'))} className={input(show('priority'))} />
        </Field>

        <label className="flex items-center justify-between gap-3 rounded-2xl bg-surface-sub px-3.5 py-3 text-sm font-semibold text-content-primary">
          Включён
          <input type="checkbox" checked={draft.isActive} onChange={(e) => set({ isActive: e.target.checked })} className="h-5 w-5 accent-[var(--color-brand,#2563eb)]" />
        </label>
        {editing && !draft.isActive && provider.routingEnabled && <p className="text-xs font-semibold text-amber-700">Если выключить провайдера, его маршрутизация тоже выключится.</p>}

        {editing && touched && !check.request && Object.keys(check.errors).length === 0 && <p className="text-xs text-content-secondary">Ничего не изменилось.</p>}
        {err && <p role="alert" className="text-xs font-semibold text-rose-600">{err}</p>}

        <div className="flex gap-2">
          <Button type="submit" className="h-11 flex-1 text-sm" disabled={busy || (touched && !check.request)}>
            <Check size={16} strokeWidth={2} /> {busy ? 'Сохраняем…' : editing ? 'Сохранить' : 'Добавить провайдера'}
          </Button>
          <button type="button" onClick={onClose} className="flex h-11 flex-1 items-center justify-center gap-1 rounded-2xl bg-surface-sub text-sm font-semibold text-content-secondary active:scale-95">
            <X size={16} strokeWidth={2} /> Отмена
          </button>
        </div>
      </form>
    </div>
  )
}

const input = (error?: string) =>
  cn('mt-1 w-full rounded-xl border bg-white px-3 py-2.5 text-sm font-medium outline-none', error ? 'border-rose-300' : 'border-blue-100/70 focus:border-brand')

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-bold text-content-primary">
      {label}
      {children}
      {error ? <span role="alert" className="mt-1 block text-xs font-semibold text-rose-600">{error}</span> : hint ? <span className="mt-1 block text-xs font-normal text-content-secondary">{hint}</span> : null}
    </label>
  )
}

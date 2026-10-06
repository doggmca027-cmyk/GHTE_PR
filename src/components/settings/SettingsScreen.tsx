import { ExternalLink, FileText, ShieldCheck } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import type { AuthSession } from '@/services/api/auth'

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-medium text-content-secondary">{label}</span>
      <span className="min-w-0 truncate font-bold text-content-primary">{value}</span>
    </div>
  )
}

function LinkRow({ href, icon: Icon, label }: { href: string; icon: typeof FileText; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between gap-3 rounded-2xl bg-surface-sub px-3.5 py-3 text-sm font-semibold text-content-primary active:scale-[0.99]"
    >
      <span className="flex items-center gap-2">
        <Icon size={16} strokeWidth={1.75} className="text-brand" />
        {label}
      </span>
      <ExternalLink size={14} strokeWidth={1.75} className="text-content-muted" />
    </a>
  )
}

export function SettingsScreen({ session }: { session: AuthSession }) {
  const { user, isMock } = session
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold tracking-tight text-content-primary">Settings</h1>

      <Card className="space-y-2.5 p-4 text-sm">
        <h2 className="text-xs font-bold uppercase tracking-wide text-content-muted">Account</h2>
        <Row label="Name" value={user.firstName ?? '-'} />
        <Row label="Username" value={user.username ? `@${user.username}` : '-'} />
        <Row label="Telegram ID" value={String(user.telegramId)} />
        {isMock && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">Dev mock account: nothing here is real.</p>}
      </Card>

      <Card className="space-y-2 p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-content-muted">Legal</h2>
        <LinkRow href="/terms.html" icon={FileText} label="Terms of Service" />
        <LinkRow href="/privacy.html" icon={ShieldCheck} label="Privacy Policy" />
      </Card>
    </div>
  )
}

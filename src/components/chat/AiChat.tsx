import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, Copy, Loader2, MessageCircle, RotateCcw, Search, Send, Sparkles, TriangleAlert, X } from 'lucide-react'
import { tr, useT } from '@/i18n'
import { askAssistant, ChatError, MAX_MESSAGE_CHARS, mockAssistant, splitAnswer, type ChatBubble, type ChatCard, type ChatFailure } from '@/lib/ai-chat'
import { copyText } from '@/lib/clipboard'
import { haptic } from '@/lib/haptics'
import { sheetOverlayClass, sheetPanelClass, useWide } from '@/lib/layout-mode'
import { cn } from '@/lib/utils'
import type { AuthSession } from '@/services/api/auth'
import { ChatServiceCard } from './ChatServiceCard'

/** What to ask first: one tap starts the conversation. */
const SUGGESTIONS = [tr('Cheapest Instagram followers'), tr('Real Instagram followers that do not drop'), tr('TikTok views')]

const FAILURES: Record<ChatFailure, string> = {
  busy: tr('The assistant is busy right now. Try again in a minute.'),
  rate_limited: tr('🤖 My AI reply limit for this hour is used up! Please use the catalogue search or contact support.'),
  offline: tr('No connection. Check the network and try again.'),
}

/** An answer of the assistant: text and **bold** as they are, every article number as a chip that copies it. */
function Answer({ text, copied, onCopy, onFind, carded }: { text: string; copied: string | null; onCopy: (article: string) => void; onFind?: (article: string) => void; carded: ReadonlySet<string> }) {
  const t = useT()
  return (
    <>
      {splitAnswer(text).map((piece, i) => {
        if (piece.kind === 'bold') return <strong key={i} className="font-bold">{piece.text}</strong>
        if (piece.kind === 'text') return <span key={i}>{piece.text}</span>
        return (
          <span key={i} className="mx-0.5 inline-flex items-center gap-1 align-baseline">
          <button
            type="button"
            onClick={() => onCopy(piece.text)}
            aria-label={`${t('Copy article number')}: ${piece.text}`}
            className="inline-flex items-center gap-1 rounded-lg bg-brand/10 px-2 py-0.5 font-mono text-[12.5px] font-bold text-brand transition-transform active:scale-95"
          >
            {piece.text}
            {copied === piece.text ? <Check size={13} strokeWidth={2.5} aria-hidden="true" /> : <Copy size={13} strokeWidth={2} aria-hidden="true" />}
          </button>
          {onFind && !carded.has(piece.text) && (
            <button
              type="button"
              onClick={() => onFind(piece.text)}
              aria-label={`${t('Find in the catalogue')}: ${piece.text}`}
              className="flex h-6 w-6 items-center justify-center rounded-lg bg-brand/10 text-brand transition-transform active:scale-95"
            >
              <Search size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
          </span>
        )
      })}
    </>
  )
}

/**
 * The AI assistant: a round button over every screen and, when it is pressed, a sheet to talk in. It answers from the live catalogue (api/chat.ts),
 * so it names real services with their article numbers and prices; an article is copied with one tap and pasted into the catalogue's search.
 * Open to a website guest as well: it reads only what the catalogue shows to everyone.
 */
export function AiChat({ session, onFindArticle, onSelectService }: { session: AuthSession; onFindArticle?: (article: string) => void; onSelectService?: (article: string) => void }) {
  const t = useT()
  const wide = useWide()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatBubble[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ChatFailure | null>(null)
  // seconds until the next question is allowed, when the hourly limit said so
  const [waitSeconds, setWaitSeconds] = useState<number | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const running = useRef<AbortController | null>(null)
  const end = useRef<HTMLDivElement>(null)

  // the conversation is kept while the sheet is closed; leaving the app stops an answer that is still being written
  useEffect(() => () => running.current?.abort(), [])
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }) }, [messages, failure, open])

  /** Asks for the answer to this conversation (it ends with the customer's question) and shows it as it is written. */
  const ask = useCallback(async (history: ChatBubble[]) => {
    const controller = new AbortController()
    running.current = controller
    setFailure(null)
    setWaitSeconds(null)
    setBusy(true)
    setMessages([...history, { role: 'assistant', content: '' }])
    let cards: ChatCard[] = [] // the services the assistant recommends arrive as it finishes
    let soFar = ''
    const show = (text: string) => { soFar = text; setMessages([...history, { role: 'assistant', content: text, ...(cards.length > 0 ? { cards } : {}) }]) }
    const showCards = (list: ChatCard[]) => { cards = list; show(soFar) }
    try {
      const answer = session.isMock ? await mockAssistant(show, showCards) : await askAssistant(history, show, controller.signal, undefined, { onCards: showCards, token: session.token })
      setMessages([...history, { role: 'assistant', content: answer, ...(cards.length > 0 ? { cards } : {}) }])
    } catch (e) {
      if (controller.signal.aborted) return
      setMessages(history) // the question stays, the empty answer goes
      setFailure(e instanceof ChatError ? e.kind : 'busy')
      setWaitSeconds(e instanceof ChatError ? e.retryAfter ?? null : null)
    } finally {
      if (running.current === controller) {
        running.current = null
        setBusy(false)
      }
    }
  }, [session.isMock, session.token])

  /** "Select" on a card: the sheet closes and the order form opens on the article. */
  const selectCard = (article: string) => {
    haptic.tap()
    setOpen(false)
    onSelectService?.(article)
  }

  const send = (text: string) => {
    const question = text.trim()
    if (question === '' || busy) return
    setDraft('')
    void ask([...messages, { role: 'user', content: question }])
  }
  const submit = (e: FormEvent) => { e.preventDefault(); send(draft) }
  const retry = () => { if (messages.at(-1)?.role === 'user') void ask(messages) }
  const restart = () => {
    running.current?.abort()
    running.current = null
    setBusy(false)
    setMessages([])
    setFailure(null)
    setWaitSeconds(null)
    setDraft('')
  }
  const copyArticle = async (article: string) => {
    if (!(await copyText(article))) return
    haptic.success()
    setCopied(article)
    window.setTimeout(() => setCopied((c) => (c === article ? null : c)), 2_000)
  }

  if (!open) {
    return (
      <button
        type="button"
        aria-label={t('AI assistant')}
        onClick={() => { haptic.tap(); setOpen(true) }}
        className={cn(
          'z-40 flex h-14 w-14 items-center justify-center rounded-full bg-brand text-white shadow-card transition-transform active:scale-95',
          wide ? 'fixed bottom-24 end-4 lg:bottom-6 lg:end-6' : 'absolute bottom-24 end-4',
        )}
      >
        <MessageCircle size={26} strokeWidth={2} />
      </button>
    )
  }

  return (
    <div role="dialog" aria-modal="true" aria-label={t('AI assistant')} className={sheetOverlayClass(wide)}>
      <button type="button" aria-label={t('Close')} onClick={() => setOpen(false)} className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
      <section
        className={cn(
          'relative z-10 flex w-full animate-sheet-up flex-col overflow-hidden rounded-t-[32px] bg-surface shadow-[0_-12px_40px_rgb(0,136,204,0.14)]',
          wide ? 'h-[88vh] sm:h-[640px]' : 'h-[88%]',
          sheetPanelClass(wide),
        )}
      >
        <div className="mx-auto mt-3 h-1.5 w-10 shrink-0 rounded-full bg-blue-100" />
        <div className="flex shrink-0 items-center justify-between px-5 pb-2 pt-3">
          <h2 className="flex items-center gap-2 text-lg font-extrabold text-content-primary">
            <Sparkles size={18} strokeWidth={2} className="text-brand" aria-hidden="true" /> {t('AI assistant')}
          </h2>
          <div className="flex items-center gap-2">
            {messages.length > 0 && (
              <button type="button" onClick={restart} aria-label={t('New chat')} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-sub text-content-secondary active:scale-90">
                <RotateCcw size={16} strokeWidth={2} />
              </button>
            )}
            <button type="button" onClick={() => setOpen(false)} aria-label={t('Close')} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-sub text-content-secondary active:scale-90">
              <X size={18} strokeWidth={2} />
            </button>
          </div>
        </div>

        <div role="log" aria-live="polite" className="flex-1 space-y-3 overflow-y-auto px-4 pb-3">
          {messages.length === 0 && (
            <div className="px-1 pt-4 text-center">
              <p className="text-[14px] font-medium leading-relaxed text-content-secondary">
                {t('Tell me what you need and I will pick services from the catalogue: the cheapest ones, or those that do not drop.')}
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((label) => (
                  <button key={label} type="button" onClick={() => send(t(label))} className="rounded-full border border-blue-100 bg-surface-sub px-3.5 py-2 text-[13px] font-semibold text-content-primary active:scale-95">
                    {t(label)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={cn('flex flex-col gap-2', m.role === 'user' ? 'items-end' : 'items-start')}>
              {/* an answer that is only cards (the model recommended and said nothing) has no empty bubble above them */}
              {(m.role === 'user' || m.content !== '' || !m.cards?.length) && (
                <div className={cn(
                  'max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed',
                  m.role === 'user' ? 'bg-brand text-white' : 'bg-surface-sub text-content-primary',
                )}>
                  {m.role === 'user'
                    ? m.content
                    : m.content === ''
                      ? <Loader2 size={16} strokeWidth={2} className="animate-spin text-brand" aria-label={t('Loading')} />
                      : <Answer text={m.content} copied={copied} carded={new Set(m.cards?.map((c) => c.sku))} onCopy={(article) => void copyArticle(article)} onFind={onFindArticle && ((article) => { setOpen(false); onFindArticle(article) })} />}
                </div>
              )}
              {m.cards && m.cards.length > 0 && (
                <div className="w-[88%] space-y-2" data-testid="chat-cards">
                  {m.cards.map((card) => <ChatServiceCard key={card.sku} card={card} onSelect={selectCard} />)}
                </div>
              )}
            </div>
          ))}
          {failure && (
            <div role="alert" className="flex items-start gap-2.5 rounded-2xl bg-rose-50 p-3.5 text-[13px] font-medium text-rose-700">
              <TriangleAlert size={18} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
              <p className="flex-1">{failure === 'rate_limited' && waitSeconds !== null ? t('🤖 My AI reply limit for this hour is used up! Please use the catalogue search or contact support. You can ask me again in {minutes} min.', { minutes: Math.max(1, Math.ceil(waitSeconds / 60)) }) : t(FAILURES[failure])}</p>
              {failure !== 'rate_limited' && messages.at(-1)?.role === 'user' && (
                <button type="button" onClick={retry} className="shrink-0 font-bold underline">{t('Try again')}</button>
              )}
            </div>
          )}
          <div ref={end} />
        </div>

        <form onSubmit={submit} className="flex shrink-0 items-center gap-2 border-t border-blue-100/70 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <input
            value={draft}
            maxLength={MAX_MESSAGE_CHARS}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('Ask about a service…')}
            aria-label={t('Ask about a service…')}
            enterKeyHint="send"
            className="h-12 min-w-0 flex-1 rounded-2xl border border-blue-100 bg-surface-sub px-4 text-[15px] font-medium text-content-primary outline-none placeholder:text-content-muted focus:bg-surface"
          />
          <button
            type="submit"
            disabled={busy || draft.trim() === ''}
            aria-label={t('Send')}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand text-white transition-transform active:scale-95 disabled:opacity-40"
          >
            {busy ? <Loader2 size={18} strokeWidth={2} className="animate-spin" /> : <Send size={18} strokeWidth={2} />}
          </button>
        </form>
      </section>
    </div>
  )
}

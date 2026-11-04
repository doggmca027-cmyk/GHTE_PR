import { Fragment, useLayoutEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Virtuoso } from 'react-virtuoso'

/**
 * A long list of cards that keeps only the cards near the screen in the page. A category is loaded 30 cards at a time and "Show more" adds the next
 * 30: after a few of them a phone's WebView (Telegram's, on a cheap Android) is carrying hundreds of cards, each with badges and a shadow. Here the
 * cards that are far from the screen are not in the page at all (their place is kept empty, so the scroll bar and the scroll position stay right),
 * and what is a little above and below the screen is, so a quick scroll does not show blank space.
 *
 * The list scrolls with its page: inside the Mini App that is the <main data-scroll-root> of the phone frame, on the website the window. A
 * browser without ResizeObserver (the library needs it) gets the whole list, as before.
 */

/** How much of the page above and below the screen is kept drawn: about three cards before, six after (the way down is the likelier way). */
export const BUFFER_PX = { top: 450, bottom: 900 }
/** A card is about this high: the first guess for the scroll bar until the real heights are measured. */
export const CARD_HEIGHT_PX = 150
/** The gap between two cards (the `space-y-3` / `gap-3` of the plain list). */
const GAP = 'pb-3'

export interface VirtualCardsProps<T> {
  items: readonly T[]
  itemKey: (item: T) => string
  renderItem: (item: T) => ReactNode
  /** The website: cards side by side (2 from tablet width, 3 from desktop). The Mini App is one column. */
  wide?: boolean
  /** What ends the list: the "Show more" button. */
  footer?: ReactNode
}

/** The items in rows of `size`: a row is one entry of the virtual list, so cards side by side scroll as one. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size))
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += n) rows.push(items.slice(i, i + n))
  return rows
}

const query = (q: string) => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q) : null)

/** The number of columns of the website's grid at this width (Tailwind's md = 768 px: two, xl = 1280 px: three); 1 when `wide` is false. */
export function useColumns(wide: boolean): number {
  const subscribe = (notify: () => void) => {
    const lists = [query('(min-width: 768px)'), query('(min-width: 1280px)')]
    for (const l of lists) l?.addEventListener('change', notify)
    return () => { for (const l of lists) l?.removeEventListener('change', notify) }
  }
  const snapshot = () => (!wide ? 1 : query('(min-width: 1280px)')?.matches ? 3 : query('(min-width: 768px)')?.matches ? 2 : 1)
  return useSyncExternalStore(subscribe, snapshot, () => 1)
}

const rowStyle = (columns: number): CSSProperties | undefined => (columns > 1 ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined)

function Row({ columns, children }: { columns: number; children: ReactNode }) {
  return <div className={columns > 1 ? `grid items-start gap-3 ${GAP}` : GAP} style={rowStyle(columns)}>{children}</div>
}

/** The end of the list, given by the caller (kept out of the component's own props so that it is not a new component on every render). */
function Footer({ context }: { context?: { footer?: ReactNode } }) {
  return context?.footer ? <div>{context.footer}</div> : null
}

export function VirtualCards<T>({ items, itemKey, renderItem, wide = false, footer }: VirtualCardsProps<T>) {
  const columns = useColumns(wide)
  const rows = useMemo(() => chunk(items, columns), [items, columns])
  // the page the list scrolls with, found once the list is in it: undefined = not looked for yet, null = the window
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [scroller, setScroller] = useState<HTMLElement | null | undefined>(undefined)
  useLayoutEffect(() => { if (host) setScroller(host.closest<HTMLElement>('[data-scroll-root]')) }, [host])

  if (typeof ResizeObserver === 'undefined') {
    return (
      <div>
        {rows.map((row) => <Row key={itemKey(row[0]!)} columns={columns}>{row.map((item) => <Fragment key={itemKey(item)}>{renderItem(item)}</Fragment>)}</Row>)}
        {footer}
      </div>
    )
  }

  return (
    <div ref={setHost}>
      {scroller !== undefined && (
        <Virtuoso
          data={rows}
          useWindowScroll={scroller === null}
          customScrollParent={scroller ?? undefined}
          computeItemKey={(_, row) => itemKey(row[0]!)}
          defaultItemHeight={CARD_HEIGHT_PX}
          increaseViewportBy={BUFFER_PX}
          context={{ footer }}
          components={{ Footer }}
          itemContent={(_, row) => <Row columns={columns}>{row.map((item) => <Fragment key={itemKey(item)}>{renderItem(item)}</Fragment>)}</Row>}
        />
      )}
    </div>
  )
}

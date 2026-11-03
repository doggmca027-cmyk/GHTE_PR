/** The browser's view of the network (Network Information API: Chromium, hence Telegram on Android and desktop; absent elsewhere, where nothing is assumed). */
type Connection = { saveData?: boolean; effectiveType?: string }

/** False on Save-Data and on 2G / 3G links, where fetching screens nobody asked for competes with the catalogue the customer is waiting for. */
export function canPrefetch(connection: Connection | undefined = (navigator as { connection?: Connection }).connection): boolean {
  return !(connection?.saveData || (connection?.effectiveType !== undefined && /^(slow-2g|2g|3g)$/.test(connection.effectiveType)))
}

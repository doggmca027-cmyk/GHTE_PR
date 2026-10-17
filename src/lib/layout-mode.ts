import { createContext, useContext } from 'react'

/**
 * 'app': the Telegram Mini App, a phone screen with the tab bar at the bottom. It stays exactly as it is.
 * 'web': the same app opened as a website in a browser: full width, a navigation bar at the top, a footer. Components only ADD classes
 * for it, so nothing the Mini App shows depends on this switch (the default is 'app').
 */
export type LayoutMode = 'app' | 'web'

export const layoutModeFor = (insideTelegram: boolean): LayoutMode => (insideTelegram ? 'app' : 'web')

export const LayoutModeContext = createContext<LayoutMode>('app')

/** True on the website (wide layout), false in the Mini App. */
export const useWide = (): boolean => useContext(LayoutModeContext) === 'web'

/** The overlay of a bottom sheet: inside the phone frame in the app; over the page on the website, a centred dialog from tablet width up. */
export const sheetOverlayClass = (wide: boolean): string =>
  wide ? 'fixed inset-0 z-50 flex items-end justify-center animate-fade-in sm:items-center sm:p-6' : 'absolute inset-0 z-50 flex items-end animate-fade-in'

/** The sheet itself on the website: a card of a readable width instead of a full-width drawer. */
export const sheetPanelClass = (wide: boolean): string => (wide ? 'sm:max-h-[88vh] sm:max-w-xl sm:rounded-[28px] sm:pb-6' : '')

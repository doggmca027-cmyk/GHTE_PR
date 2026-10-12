/** Mirrors the users table (camelCased). */
export interface IUser {
  /** users.id (UUID) - equals auth.uid() in RLS. */
  id: string
  /** null for an account created with e-mail (web sign-in) that never linked Telegram. */
  telegramId: number | null
  /** The verified e-mail of a web account; absent / null for Telegram-only accounts. */
  email?: string | null
  username: string | null
  firstName: string | null
  languageCode: string | null
  /**
   * Only decides whether the Admin tab is SHOWN. It is not a permission: every admin RPC re-checks
   * the database flag, so editing this value in the browser grants nothing.
   */
  isAdmin: boolean
}

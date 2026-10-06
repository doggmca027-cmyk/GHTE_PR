/** Mirrors the users table (camelCased). */
export interface IUser {
  /** users.id (UUID) - equals auth.uid() in RLS. */
  id: string
  telegramId: number
  username: string | null
  firstName: string | null
  languageCode: string | null
  /**
   * Only decides whether the Admin tab is SHOWN. It is not a permission: every admin RPC re-checks
   * the database flag, so editing this value in the browser grants nothing.
   */
  isAdmin: boolean
}

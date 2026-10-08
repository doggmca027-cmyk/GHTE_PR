// Pure logic of the provider form (ProviderModal): validation and the UPSERT_PROVIDER request it produces. No React, no I/O.
//
// The API key rule: when EDITING, an empty key field means "keep the stored key", so apiKey is simply left out of the request and
// the server leaves api_key_encrypted alone. When CREATING, the key is optional too (a provider without one cannot get routing),
// but the form says so. The key is never put in an error message or returned from here other than inside the request body.

import type { AdminProvider, UpsertProviderRequest } from '@/types/admin-providers'

export interface ProviderDraft {
  name: string
  apiUrl: string
  /** Raw text of the password field. Empty on edit = keep the current key. */
  apiKey: string
  priority: string
  isActive: boolean
}

export interface ProviderDraftCheck {
  errors: Partial<Record<'name' | 'apiUrl' | 'apiKey' | 'priority', string>>
  /** The request to send, or null while the form is invalid or (when editing) nothing changed. */
  request: UpsertProviderRequest | null
}

export const emptyDraft = (): ProviderDraft => ({ name: '', apiUrl: '', apiKey: '', priority: '0', isActive: true })

export const draftOf = (p: AdminProvider): ProviderDraft => ({ name: p.name, apiUrl: p.apiUrl, apiKey: '', priority: String(p.priority), isActive: p.isActive })

/** The frontend half of the URL rule (the server also refuses private hosts): https:// and a parsable URL. */
export function checkProviderUrl(raw: string): string | null {
  const text = raw.trim()
  if (!text) return 'API URL is required.'
  if (!text.startsWith('https://')) return 'API URL must start with https://'
  try {
    new URL(text)
  } catch {
    return 'API URL is not a valid URL.'
  }
  return null
}

export function checkProviderDraft(draft: ProviderDraft, editing: AdminProvider | null): ProviderDraftCheck {
  const errors: ProviderDraftCheck['errors'] = {}
  const name = draft.name.trim()
  if (!name) errors.name = 'Name is required.'
  else if (name.length > 80) errors.name = 'Name must be at most 80 characters.'

  const urlError = checkProviderUrl(draft.apiUrl)
  if (urlError) errors.apiUrl = urlError

  const key = draft.apiKey.trim()
  if (key && (key.length < 8 || key.length > 512)) errors.apiKey = 'API key must be 8 to 512 characters.'
  else if (/\s/.test(key)) errors.apiKey = 'API key must not contain spaces.'

  const priorityText = draft.priority.trim()
  const priority = /^-?\d{1,5}$/.test(priorityText) ? Number(priorityText) : null
  if (priority === null || Math.abs(priority) > 10_000) errors.priority = 'Priority must be a whole number from -10000 to 10000.'

  if (Object.keys(errors).length > 0 || priority === null) return { errors, request: null }

  if (!editing) {
    return {
      errors,
      request: { action: 'UPSERT_PROVIDER', name, apiUrl: draft.apiUrl.trim(), priority, isActive: draft.isActive, ...(key ? { apiKey: key } : {}) },
    }
  }

  // Edit: send only what changed. An empty key field never reaches the request, so the stored key is kept.
  const patch: UpsertProviderRequest = { action: 'UPSERT_PROVIDER', id: editing.id }
  if (name !== editing.name) patch.name = name
  if (draft.apiUrl.trim() !== editing.apiUrl) patch.apiUrl = draft.apiUrl.trim()
  if (priority !== editing.priority) patch.priority = priority
  if (draft.isActive !== editing.isActive) patch.isActive = draft.isActive
  if (key) patch.apiKey = key
  return { errors, request: Object.keys(patch).length > 2 ? patch : null }
}

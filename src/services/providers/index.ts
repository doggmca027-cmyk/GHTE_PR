import type { ISMMProviderAdapter } from '@/types'

const registry = new Map<string, ISMMProviderAdapter>()

export function registerProvider(adapter: ISMMProviderAdapter): void {
  registry.set(adapter.id, adapter)
}

export function getProvider(id: string): ISMMProviderAdapter | undefined {
  return registry.get(id)
}

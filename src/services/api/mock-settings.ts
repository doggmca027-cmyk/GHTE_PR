// Offline kill switches for dev mock mode (the real ones live in platform_settings and are enforced by the Edge Functions).
import type { PlatformSettingsPatch, PlatformSettingsView } from '@/types/admin'
import { AdminApiError } from './mock-admin'

export function createMockSettings() {
  let s: PlatformSettingsView = { globalOrdersEnabled: true, globalPaymentsEnabled: true, maintenanceMode: false, updatedAt: null }
  return {
    get: (): PlatformSettingsView => ({ ...s }),
    update(patch: PlatformSettingsPatch): PlatformSettingsView {
      if (patch.ordersEnabled === undefined && patch.paymentsEnabled === undefined && patch.maintenanceMode === undefined) {
        throw new AdminApiError('invalid_input', 'Nothing to update.')
      }
      s = {
        globalOrdersEnabled: patch.ordersEnabled ?? s.globalOrdersEnabled,
        globalPaymentsEnabled: patch.paymentsEnabled ?? s.globalPaymentsEnabled,
        maintenanceMode: patch.maintenanceMode ?? s.maintenanceMode,
        updatedAt: new Date().toISOString(),
      }
      return { ...s }
    },
  }
}

// Offline kill switches for dev mock mode (the real ones live in platform_settings and are enforced by the Edge Functions).
import { NO_UNFUNDED, type PlatformSettingsPatch, type PlatformSettingsView } from '@/types/admin'
import { AdminApiError } from './mock-admin'

export function createMockSettings() {
  let s: PlatformSettingsView = {
    globalOrdersEnabled: true, globalPaymentsEnabled: true, maintenanceMode: false,
    deferredOrdersEnabled: false, deferredOrdersCap: 200, deferredOrdersTtlHours: 24, unfunded: NO_UNFUNDED, updatedAt: null,
  }
  return {
    get: (): PlatformSettingsView => ({ ...s }),
    update(patch: PlatformSettingsPatch): PlatformSettingsView {
      if (patch.ordersEnabled === undefined && patch.paymentsEnabled === undefined && patch.maintenanceMode === undefined && patch.deferredOrdersEnabled === undefined) {
        throw new AdminApiError('invalid_input', 'Nothing to update.')
      }
      s = {
        ...s,
        globalOrdersEnabled: patch.ordersEnabled ?? s.globalOrdersEnabled,
        globalPaymentsEnabled: patch.paymentsEnabled ?? s.globalPaymentsEnabled,
        maintenanceMode: patch.maintenanceMode ?? s.maintenanceMode,
        deferredOrdersEnabled: patch.deferredOrdersEnabled ?? s.deferredOrdersEnabled,
        updatedAt: new Date().toISOString(),
      }
      return { ...s }
    },
  }
}

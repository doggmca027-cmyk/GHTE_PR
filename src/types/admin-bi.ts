// Shapes of the admin-analytics function's product-analytics answer ({ action: 'BI', days }). Admins only.
// Every section is { data } or { error } on its own: one failed query shows on its card while the rest still loads.
export type {
  BiRange,
  BiResponse,
  FunnelStep,
  RetentionCohort,
  RevenueDay,
  Section,
  TopService,
} from '../../supabase/functions/_shared/admin-bi.ts'

export { BI_RANGES } from '../../supabase/functions/_shared/admin-bi.ts'

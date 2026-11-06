// GET /api/catalog-version: {"version": "<md5>", "services": N}, the version of what the storefront shows (view catalog_version). The app asks it first and
// downloads the catalogue again only when it has changed. Kept 1 hour by the CDN: at most one request an hour per region reaches Supabase.
// Edge runtime. See _lib/catalog-proxy.ts.

import { handleCatalogVersion } from './_lib/catalog-proxy'

export const config = { runtime: 'edge' }

export default function handler(request: Request): Promise<Response> {
  const env = process.env
  return handleCatalogVersion(request, { env: { supabaseUrl: env.VITE_SUPABASE_URL ?? env.SUPABASE_URL, anonKey: env.VITE_SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY }, fetch })
}

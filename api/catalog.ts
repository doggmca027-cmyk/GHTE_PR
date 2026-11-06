// GET /api/catalog?p=<PostgREST path>&v=<version>: the public catalogue (platforms, categories, services) through Vercel's CDN, so that Supabase is asked
// once per version of the catalogue and not once per customer (the free plan allows 5 GB of egress). Edge runtime. See _lib/catalog-proxy.ts.
// Needs, in the Vercel project, the VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY the app is built with (the same pair /api/chat reads): nothing new.

import { handleCatalog } from './_lib/catalog-proxy'

export const config = { runtime: 'edge' }

export default function handler(request: Request): Promise<Response> {
  const env = process.env
  return handleCatalog(request, { env: { supabaseUrl: env.VITE_SUPABASE_URL ?? env.SUPABASE_URL, anonKey: env.VITE_SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY }, fetch })
}

// Worker heartbeat: an HTTP worker started by pg_cron reports here when its run ends, so the System Health screen can tell
// "the scheduler fired" (pg_cron's log) from "the worker really ran to the end" (this). Best effort and bounded: a failure to
// report is logged and swallowed, it can never fail or delay the run it describes beyond one short database call.

import { serializeError, type Logger } from './logger.ts'

/** The slice of the supabase-js client used here (structural, so this file has no npm imports). */
export interface RpcLike {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>
}

export async function recordHeartbeat(
  db: RpcLike,
  worker: string,
  run: { ok: true; startedAt: number } | { ok: false; startedAt: number; error: unknown },
  log: Pick<Logger, 'warn'>,
  now: () => number = Date.now,
): Promise<void> {
  try {
    const { error } = await db.rpc('record_worker_heartbeat', {
      p_worker: worker,
      p_ok: run.ok,
      // the message is scrubbed of tokens / keys / long opaque strings and cut to 300 characters by the database
      p_error: run.ok ? null : serializeError(run.error).message,
      p_duration_ms: Math.max(0, now() - run.startedAt),
    })
    if (error) log.warn('heartbeat not recorded', { err: error, error_code: 'heartbeat_failed', worker })
  } catch (e) {
    log.warn('heartbeat not recorded', { err: e, error_code: 'heartbeat_failed', worker })
  }
}

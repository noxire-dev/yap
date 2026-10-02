import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const home = process.env.KUMI_HOME ?? join(homedir(), '.kumi')
export const port = Number(process.env.KUMI_PORT ?? 4170)
// 127.0.0.1, not localhost: Windows tries ::1 first and the daemon only binds v4.
export const url = `http://127.0.0.1:${port}`

/** Changes whenever the source does, so a client can tell it is talking to a daemon running older code. */
export const build = Math.max(...readdirSync(import.meta.dir).map(f => statSync(join(import.meta.dir, f)).mtimeMs))

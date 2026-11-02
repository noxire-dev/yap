import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const home = process.env.YAP_HOME ?? join(homedir(), '.yap')
export const port = Number(process.env.YAP_PORT ?? 4170)
// 127.0.0.1, not localhost: Windows tries ::1 first and the daemon only binds v4.
export const url = `http://127.0.0.1:${port}`

/** What a user can set with `yap config <key> <value>`, and what each is until they do. */
export const SETTINGS = {
  /** Background sessions (`spawn`) that may run at once. Each is a Claude Code session on the user's subscription. */
  spawns: 3,
}
export type Settings = typeof SETTINGS

/** ~/.yap/config.json over the defaults. Read on every use, so a change needs no restart. */
export function settings(): Settings {
  let saved: Partial<Settings> = {}
  try {
    saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
  } catch {}
  return { ...SETTINGS, ...saved }
}

/** This copy of yap: the checkout or plugin install it runs from, and its release. */
export const dir = join(import.meta.dir, '..')
export const version: string = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version

/** Changes whenever the source does, so a client can tell it is talking to a daemon running older code. */
export const build = Math.max(...readdirSync(import.meta.dir).map(f => statSync(join(import.meta.dir, f)).mtimeMs))

// What a crew agent or a gate gets of the daemon's environment. The daemon is often started from inside a Claude
// Code session or a Herdr pane, so its environment carries their ids, sockets and tokens: enough for an agent to
// speak as that session or drive other panes. Plus whatever secrets the shell exported. YAP_PASS names more.
const KEEP = /^(path|pathext|systemroot|systemdrive|windir|comspec|os|processor_\w+|number_of_processors|programfiles.*|programdata|programw6432|commonprogram.*|allusersprofile|public|computername|username|userdomain\w*|userprofile|homedrive|homepath|appdata|localappdata|temp|tmp|tmpdir|psmodulepath|home|user|logname|shell|lang|lc_\w+|tz|term|xdg_\w+|nvm_\w+|volta_home|pnpm_home|bun_install|deno_dir|java_home|gopath|goroot|cargo_home|rustup_home|dotnet_root|pyenv\w*|chocolateyinstall|claude_config_dir)$/i

export function childEnv(env: Record<string, string | undefined> = process.env) {
  const pass = new Set((env.YAP_PASS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (KEEP.test(k) || pass.has(k.toLowerCase()))) out[k] = v
  return out
}

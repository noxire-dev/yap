#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { home, url } from './env'
import { type Client, type State, Tui, status, useColor } from './tui'

const USAGE = `kumi           open the board (starts the daemon if it isn't running)
kumi status    print every project's rail and exit
kumi start     start the daemon in the background
kumi serve     run the daemon in the foreground
kumi stop      stop the daemon; running agents are killed and their tickets requeued`

class HttpClient implements Client {
  async get<T>(path: string) {
    return this.read(await fetch(url + path)) as Promise<T>
  }

  async send(method: 'POST' | 'PATCH', path: string, body: object = {}) {
    return this.read(await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  }

  private async read(res: Response) {
    const data: any = await res.json()
    if (!res.ok) throw new Error(data?.error ?? res.statusText)
    return data
  }

  watch(ping: () => void, down: (isDown: boolean) => void) {
    void (async () => {
      for (;;) {
        try {
          const res = await fetch(`${url}/api/stream`)
          down(false)
          for await (const _ of res.body!) ping()
        } catch {
          down(true)
          await Bun.sleep(1000)
        }
      }
    })()
  }
}

const up = () =>
  fetch(`${url}/api/state`, { signal: AbortSignal.timeout(500) }).then(
    r => r.ok,
    () => false,
  )

async function daemon() {
  if (await up()) return
  mkdirSync(home, { recursive: true })
  const log = openSync(join(home, 'daemon.log'), 'a')
  spawn(process.execPath, [join(import.meta.dir, 'server.ts')], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref()
  for (let i = 0; i < 50; i++) {
    if (await up()) return
    await Bun.sleep(100)
  }
  throw new Error(`the daemon did not start. See ${join(home, 'daemon.log')}`)
}

const seenFile = join(home, 'seen')
const readSeen = () => {
  try {
    return Number(readFileSync(seenFile, 'utf8')) || 0
  } catch {
    return 0
  }
}

const SCREEN_ON = '\x1b[?1049h\x1b[?25l'
const SCREEN_OFF = '\x1b[?25h\x1b[?1049l'

async function board() {
  await daemon()
  const { stdin, stdout } = process
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('the board needs a terminal. Try `kumi status`.')

  const screen = (on: boolean) => {
    stdin.setRawMode(on)
    stdout.write(on ? SCREEN_ON : SCREEN_OFF)
  }

  const tui = new Tui(
    new HttpClient(),
    {
      get columns() {
        return stdout.columns
      },
      get rows() {
        return stdout.rows
      },
      write: s => void stdout.write(s),
    },
    {
      cwd: process.cwd(),
      seen: readSeen(),
      edit(text) {
        const file = join(tmpdir(), `kumi-${Date.now()}.md`)
        writeFileSync(file, text)
        const editor = process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad' : 'vi')
        screen(false)
        const ran = spawnSync(`${editor} "${file}"`, { stdio: 'inherit', shell: true })
        screen(true)
        const out = ran.status === 0 ? readFileSync(file, 'utf8') : text
        rmSync(file, { force: true })
        return out === text ? null : out
      },
      quit() {
        screen(false)
        writeFileSync(seenFile, String(Date.now()))
        process.exit(0)
      },
    },
  )

  useColor(!process.env.NO_COLOR)
  screen(true)
  stdin.on('data', d => void tui.key(d.toString()))
  stdout.on('resize', () => tui.render())
  await tui.start()
}

const cmd = process.argv[2]
try {
  if (!cmd) await board()
  else if (cmd === 'serve') await import('./server')
  else if (cmd === 'start') await daemon()
  else if (cmd === 'status') {
    useColor(!!process.stdout.isTTY && !process.env.NO_COLOR)
    if (!(await up())) console.log('the daemon is not running. `kumi` starts it.')
    else console.log(status(await new HttpClient().get<State>('/api/state'), process.stdout.columns || 100, readSeen()))
  } else if (cmd === 'stop') {
    console.log((await up()) ? (await new HttpClient().send('POST', '/api/stop'), 'stopped') : 'not running')
  } else console.log(USAGE)
} catch (e: any) {
  console.error(`kumi: ${e?.message ?? e}`)
  process.exit(1)
}

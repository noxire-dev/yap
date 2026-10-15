import type { Human } from './ports'

const WAIT = 120_000

/** A native yes/no dialog on the desktop, No by default. Unanswered in two minutes is a no. */
export class Dialog implements Human {
  async confirm(question: string) {
    const cmd =
      process.platform === 'win32'
        ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show($env:KUMI_Q, 'kumi', 'YesNo', 'Warning', 'Button2', 'DefaultDesktopOnly')"]
        : process.platform === 'darwin'
          ? ['osascript', '-e', `display dialog (system attribute "KUMI_Q") buttons {"No", "Yes"} default button "No" with title "kumi" giving up after ${WAIT / 1000}`]
          : ['zenity', '--question', '--title=kumi', '--default-cancel', `--timeout=${WAIT / 1000}`, '--text', question]
    let p
    try {
      p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', env: { ...process.env, KUMI_Q: question }, windowsHide: true, timeout: WAIT + 5000 })
    } catch {
      throw new Error('this needs a yes on the desktop and there is no dialog here (zenity on Linux); KUMI_YOLO=1 on the daemon skips the question')
    }
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    return process.platform === 'linux' ? code === 0 : /\bYes\b/.test(out)
  }
}

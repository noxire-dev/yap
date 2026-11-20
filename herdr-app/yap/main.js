// yap in the Herdr app: the agents working in this space's repo, what each is doing, and the repo's Rinai board.
// It reads the yap daemon on this computer (http://127.0.0.1:4170, token in ~/.yap/token).

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, spaces, focused, run, theme, home, readTextFile, checking } from "herdr";

const URL = "http://127.0.0.1:4170";
const key = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const under = (dir, top) => dir === top || dir.startsWith(top + "/");
const ago = (ms) => {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
};

export default class Yap extends View {
  init(_props, cx) {
    this.sessions = [];
    this.projects = [];
    this.cards = {};
    this.down = null;
    if (checking()) return;
    cx.spawn(async (cx) => {
      try {
        this.token = (await readTextFile(`${home()}/.yap/token`)).trim();
      } catch {
        this.down = "no ~/.yap/token: run `yap` once";
      }
      await this.refresh(cx);
    });
    cx.timer.every(3000, (cx) => cx.spawn(async (cx) => this.refresh(cx)));
  }

  async get(path) {
    const r = await fetch(URL + path, { headers: { "x-yap-token": this.token } });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  }

  async refresh(cx) {
    if (!this.token) return cx.notify();
    try {
      this.sessions = await this.get("/api/sessions");
      const s = await this.get("/api/state");
      this.projects = s.projects;
      this.down = null;
      // The board only for the repo in front of you, and not every 3s: it is a GitHub read.
      const p = this.project();
      if (p && (!this.cards[p.id] || Date.now() - this.cards[p.id].at > 30000))
        this.cards[p.id] = { at: Date.now(), list: await this.get(`/api/projects/${p.id}/cards`).catch((e) => ({ error: String(e.message ?? e) })) };
    } catch {
      this.down = "the yap daemon isn't running: `yap start`";
    }
    cx.notify();
  }

  // Where you are: the focused terminal's folder, else the active space's.
  here() {
    return key(focused()?.cwd ?? spaces().find((s) => s.active)?.folder);
  }

  project() {
    const here = this.here();
    return this.projects.filter((p) => under(here, key(p.path))).sort((a, b) => b.path.length - a.path.length)[0];
  }

  render(cx) {
    const t = theme();
    const head = (text) => div().text_size(11).font_semibold().text_color(t.dim).pt(10).pb(4).child(text);
    const line = (text, color = t.muted) => div().text_size(12).text_color(color).truncate().child(text);
    if (this.down) return v_flex().size_full().bg(t.chrome).p(10).child(line(this.down, t.dim));

    const here = this.here();
    const status = new Map(agents().map((a) => [a.address, a.status]));
    // Yours: the sessions whose working tree you are in. A space at ~ has none; everything is "elsewhere".
    const mine = this.sessions.filter((s) => under(here, key(s.top)));
    const others = this.sessions.filter((s) => !mine.includes(s));
    const row = (s) => {
      const st = s.terminal ? status.get(s.terminal) : null;
      return v_flex()
        .id(`s-${s.id}`)
        .px(6).py(4).rounded(4)
        .hover((x) => x.bg(t.hover))
        .when(!!s.terminal, (x) => x.on_click(() => run("agent.focus", { terminal: s.terminal })))
        .child(
          h_flex().gap(6).items_center()
            .child(div().w(7).h(7).rounded(4).bg(st ? t[st] ?? t.unknown : t.dim))
            .child(div().text_size(13).text_color(t.foreground).flex_1().truncate().child(`@${s.name || s.id.slice(0, 8)}`))
            .child(div().text_size(11).text_color(t.dim).child(ago(s.at))),
        )
        .when(s.files.length > 0, (x) => x.child(line(`edited ${s.files.slice(-3).join(", ")}`)))
        .children((s.conflicts ?? []).map((c) => line(`conflicts with ${c.with.slice(0, 8)} in ${c.files.join(", ")}`, t.blocked)))
        .children((s.unanswered ?? []).map((q) => line(`${q.kind} to ${q.to.join(", ")}: ${q.text}`, t.blocked)));
    };

    const p = this.project();
    const board = p && this.cards[p.id]?.list;
    const columns = Array.isArray(board) ? [...new Set(board.map((c) => c.column))] : [];

    return v_flex().size_full().bg(t.chrome).px(10).pb(10).overflow_y_scrollbar()
      .child(head(mine.length ? "AGENTS HERE" : "NO AGENTS IN THIS REPO"))
      .children(mine.map(row))
      .when(others.length > 0, (x) => x.child(head("ELSEWHERE")).children(others.map(row)))
      .when(!!p, (x) =>
        x.child(head(`BOARD · ${p.name}`))
          .when(!!board?.error, (y) => y.child(line(board.error, t.dim)))
          .children(columns.map((col) =>
            v_flex().pb(6)
              .child(div().text_size(12).text_color(t.muted).child(col))
              .children(board.filter((c) => c.column === col).slice(0, 8).map((c) =>
                h_flex().gap(6)
                  .child(div().text_size(12).text_color(t.dim).flex_none().child(`#${c.number}`))
                  .child(div().text_size(12).text_color(c.onRail ? t.accent : t.foreground).truncate().child(c.title)))))));
  }
}

// yap in the Herdr app: the crew's goals and tickets for the repo you're in, each crew agent's live terminal a click
// away, the repo's Rinai board (hand a card to the crew), and the other agent sessions in the repo.
// It talks to the yap daemon on this computer (http://127.0.0.1:4170, token in ~/.yap/token).

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, panes, spaces, focused, terminals, run, theme, home, readTextFile, checking } from "herdr";

const URL = "http://127.0.0.1:4170";
const key = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const under = (dir, top) => dir === top || dir.startsWith(top + "/");
const ago = (ms) => {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
};
// A ticket's state as a theme color: running work is "working", what needs you is "blocked".
const TONE = { draft: "dim", todo: "muted", working: "working", review: "working", gate: "working", merged: "done", escalated: "blocked", dropped: "dim" };
const RUNNING = ["working", "review", "gate"];

export default class Yap extends View {
  init(_props, cx) {
    this.sessions = [];
    this.state = { projects: [], goals: [], tickets: [], activity: {} };
    this.cards = {};
    this.down = null;
    this.said = null;
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

  async call(path, body) {
    const r = await fetch(URL + path, {
      method: body ? "POST" : "GET",
      headers: { "x-yap-token": this.token, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error ?? `${path}: ${r.status}`);
    return out;
  }

  async refresh(cx) {
    if (!this.token) return cx.notify();
    try {
      this.sessions = await this.call("/api/sessions");
      this.state = await this.call("/api/state");
      this.down = null;
      // The board only for the repo in front of you, and not every 3s: it is a GitHub read.
      const p = this.project();
      if (p && (!this.cards[p.id] || Date.now() - this.cards[p.id].at > 30000))
        this.cards[p.id] = { at: Date.now(), list: await this.call(`/api/projects/${p.id}/cards`).catch((e) => ({ error: String(e.message ?? e) })) };
    } catch {
      this.down = "the yap daemon isn't running: `yap start`";
    }
    cx.notify();
  }

  // A button's work: the daemon's answer or error shows under the header until the next one.
  act(what, path, body) {
    return (_e, cx) =>
      cx.spawn(async (cx) => {
        try {
          await this.call(path, body ?? {});
          this.said = `${what}: done`;
        } catch (e) {
          this.said = `${what}: ${e.message ?? e}`;
        }
        if (path.startsWith("/api/goals") && body?.issue) delete this.cards[body.project_id];
        await this.refresh(cx);
      });
  }

  // Where you are: the focused terminal's folder, else (this panel has the focus) a terminal's in the same tab,
  // else the active space's.
  here() {
    const f = focused();
    const tab = panes().find((p) => p.tab === f?.tab && p.cwd)?.cwd;
    return key(f?.cwd ?? tab ?? spaces().find((s) => s.active)?.folder);
  }

  project() {
    const here = this.here();
    return this.state.projects.filter((p) => under(here, key(p.path))).sort((a, b) => b.path.length - a.path.length)[0];
  }

  render(cx) {
    const t = theme();
    const head = (text) => div().text_size(11).font_semibold().text_color(t.dim).pt(12).pb(4).child(text);
    const line = (text, color = t.muted) => div().text_size(12).text_color(color).truncate().child(text);
    const button = (id, label, onClick) =>
      div().id(id).flex_none().px(6).rounded(3).text_size(11).text_color(t.foreground).bg(t.raised).hover((x) => x.bg(t.hover)).on_click(onClick).child(label);
    if (this.down) return v_flex().size_full().bg(t.chrome).p(10).child(line(this.down, t.dim));

    const here = this.here();
    const p = this.project();
    // A crew agent's live terminal, by the label the runner gave it: t12 for a ticket, g3 for a goal's planner.
    const crewTerms = terminals().filter((x) => x.state === "live" && x.labels?.["yap.crew"]);
    const live = new Map(crewTerms.map((x) => [x.labels["yap.crew"], x.address]));
    // A crew agent stuck on a question (a permission, a folder to trust) waits on you in its terminal.
    const waiting = new Set(crewTerms.filter((x) => x.status === "blocked").map((x) => x.labels["yap.crew"]));
    const waits = (label) => waiting.has(label) && line("waits on you in its terminal: watch it to answer", t.blocked);
    const watch = (label) => live.has(label) && button(`w-${label}`, "watch", () => run("terminal.keep", { terminal: live.get(label), place: "right" }));

    const ticket = (k) => {
      const a = this.state.activity?.[k.id];
      return v_flex().px(6).py(3).rounded(4).hover((x) => x.bg(t.hover))
        .child(
          h_flex().gap(6).items_center()
            .child(div().w(7).h(7).rounded(4).flex_none().bg(t[TONE[k.status]] ?? t.dim))
            .child(div().text_size(12).text_color(t.dim).flex_none().child(`t${k.id}`))
            .child(div().text_size(12).text_color(k.status === "merged" ? t.muted : t.foreground).flex_1().truncate().child(k.title))
            .when(RUNNING.includes(k.status), (x) => x.child(watch(`t${k.id}`) || div()))
            .when(k.status === "escalated", (x) => x.child(button(`r-${k.id}`, "retry", this.act(`t${k.id}`, `/api/tickets/${k.id}/retry`))))
            .when(["escalated", "draft", "todo"].includes(k.status), (x) => x.child(button(`d-${k.id}`, "drop", this.act(`t${k.id}`, `/api/tickets/${k.id}/drop`)))),
        )
        .when(RUNNING.includes(k.status), (x) => x.child(line(`${k.status}${k.round ? `, round ${k.round}` : ""}${a?.line ? ` · ${a.line}` : ""}`)))
        .when(waiting.has(`t${k.id}`), (x) => x.child(waits(`t${k.id}`)))
        .when(k.status === "escalated" && !!k.note, (x) => x.child(line(k.note.split("\n")[0], t.blocked)));
    };

    const goals = p ? this.state.goals.filter((g) => g.project_id === p.id && g.status !== "failed").slice(-6).reverse() : [];
    const goal = (g) => {
      const ks = this.state.tickets.filter((k) => k.goal_id === g.id && k.status !== "dropped");
      const open = ks.filter((k) => k.status !== "merged");
      const merged = ks.length - open.length;
      return v_flex().pb(8)
        .child(
          h_flex().gap(6).items_center()
            .child(div().text_size(13).text_color(t.foreground).flex_1().truncate().child(g.text))
            .when(g.status === "planning", (x) => x.child(watch(`g${g.id}`) || div()))
            .when(ks.some((k) => k.status === "draft"), (x) => x.child(button(`s-${g.id}`, "start", this.act(`goal ${g.id}`, `/api/goals/${g.id}/start`)))),
        )
        .when(g.status === "planning", (x) => x.child(waits(`g${g.id}`) || line("planning…")))
        .children(open.map(ticket))
        .when(merged > 0, (x) => x.child(line(`${merged} merged${open.length ? "" : ", all done"}`, t.dim)));
    };

    const status = new Map(agents().map((a) => [a.address, a.status]));
    // Peers: the sessions in the repo you are in, found by the deepest working tree around you, so a session
    // rooted at ~ doesn't make everything "here". Crew agents show under their ticket instead.
    const crew = new Set(live.values());
    const around = this.sessions.filter((s) => under(here, key(s.top))).sort((a, b) => b.top.length - a.top.length)[0];
    const mine = around ? this.sessions.filter((s) => s.repo === around.repo && !crew.has(s.terminal)) : [];
    const peer = (s) => {
      const st = s.terminal ? status.get(s.terminal) : null;
      return v_flex().id(`p-${s.id}`).px(6).py(3).rounded(4).hover((x) => x.bg(t.hover))
        .when(!!s.terminal, (x) => x.on_click(() => run("agent.focus", { terminal: s.terminal })))
        .child(
          h_flex().gap(6).items_center()
            .child(div().w(7).h(7).rounded(4).flex_none().bg(st ? t[st] ?? t.unknown : t.dim))
            .child(div().text_size(12).text_color(t.foreground).flex_1().truncate().child(`@${s.name || s.id.slice(0, 8)}`))
            .child(div().text_size(11).text_color(t.dim).child(ago(s.at))),
        )
        .when(s.files.length > 0, (x) => x.child(line(`edited ${s.files.slice(-3).join(", ")}`)))
        .children((s.conflicts ?? []).map((c) => line(`conflicts with ${c.with.slice(0, 8)} in ${c.files.join(", ")}`, t.blocked)))
        .children((s.unanswered ?? []).map((q) => line(`${q.kind} to ${q.to.join(", ")}: ${q.text}`, t.blocked)));
    };

    const board = p && this.cards[p.id]?.list;
    const columns = Array.isArray(board) ? [...new Set(board.map((c) => c.column))] : [];

    return v_flex().size_full().bg(t.chrome).px(10).pb(10).overflow_y_scrollbar()
      .when(!!this.said, (x) => x.child(div().pt(8).child(line(this.said, t.accent))))
      .child(head(p ? `CREW · ${p.name}` : "CREW"))
      .when(!p, (x) => x.child(line("this repo isn't a yap project: run `yap` in it to add it", t.dim)))
      .when(!!p && !goals.length, (x) => x.child(line("no goals yet: hand it a card below, or `yap` to type one", t.dim)))
      .children(goals.map(goal))
      .child(head(mine.length ? "AGENTS HERE" : "NO OTHER AGENTS HERE"))
      .children(mine.map(peer))
      .when(!!p, (x) =>
        x.child(head("BOARD"))
          .when(!!board?.error, (y) => y.child(line(board.error, t.dim)))
          .children(columns.map((col) =>
            v_flex().pb(6)
              .child(div().text_size(12).text_color(t.muted).child(col))
              .children(board.filter((c) => c.column === col).slice(0, 8).map((c) =>
                h_flex().gap(6).items_center().px(6).rounded(4).hover((y) => y.bg(t.hover))
                  .child(div().text_size(12).text_color(t.dim).flex_none().child(`#${c.number}`))
                  .child(div().text_size(12).text_color(c.onRail ? t.accent : t.foreground).flex_1().truncate().child(c.title))
                  .when(!c.onRail, (y) => y.child(button(`c-${c.number}`, "→ crew", this.act(`#${c.number}`, "/api/goals", { project_id: p.id, issue: c.number, title: c.title })))))))));
  }
}

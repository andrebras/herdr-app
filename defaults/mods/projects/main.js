// Open a project: the git repos under your folders, as tmux-sessionizer lists them. Type
// to filter, ↑/↓ and Enter: go to the project's space, or make one there named after the
// folder. Open spaces come first. A typed path to a folder (~/code/foo) opens that folder
// when nothing matches; nothing else happens then. It never makes folders.
//
// Where it looks: projects.json in Herdr's folder,
//   { "roots": ["~/Lab"], "depth": 3, "folders": ["~/notes"] }
// roots are searched for repos `depth` folders down; folders are listed as they are.
// Without the file: ~/Lab, 3 deep. It looks again each time it opens.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { readFile } from "fs/promises";
import { spaces, panes, run, exec, theme, props, closeOverlay, home, appHome } from "herdr";

const DEFAULTS = { roots: ["~/Lab"], depth: 3, folders: [] };
// How many matches show: the best ones, as a fuzzy finder does.
const SHOWN = 12;

export default class Projects extends View {
  init(_props, cx) {
    this.filter = "";
    this.at = 0;
    this.repos = null; // absolute paths, once found
    this.input = InputState.new({ placeholder: "Open a project…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => cx.spawn((cx) => this.go(this.rows()[this.at], cx)));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      this.repos = await findProjects(await config());
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  // Open spaces on this computer, then the projects without one, best matches first.
  rows() {
    const open = spaces().filter((s) => !s.machine);
    const rows = open.map((s) => ({ kind: "space", space: s, name: s.name, path: liveFolder(s) }));
    const taken = new Set(rows.map((r) => r.path));
    for (const path of this.repos ?? []) {
      if (!taken.has(path) && !spaceFor(path)) rows.push({ kind: "project", name: base(path), path });
    }
    const f = this.filter.trim().toLowerCase();
    if (!f) return rows.slice(0, SHOWN);
    return rows
      .map((r) => ({ r, s: score(f, r.name.toLowerCase(), short(r.path).toLowerCase()) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, SHOWN)
      .map((x) => x.r);
  }

  async go(r, cx) {
    if (!r) return this.openTyped(cx);
    this.close();
    if (r.kind === "space") return run("space.select", { id: r.space.id });
    const there = spaceFor(r.path);
    if (there) run("space.select", { id: there.id });
    else run("space.new", { folder: r.path, name: r.name });
  }

  // Nothing matched: a typed folder that exists opens; anything else does nothing.
  async openTyped(cx) {
    const typed = this.filter.trim();
    if (!/^[~/]/.test(typed)) return;
    const path = expand(typed).replace(/\/+$/, "") || "/";
    const r = await exec("test", ["-d", path]).catch(() => ({ code: 1 }));
    if (r.code !== 0) {
      this.missing = typed;
      cx.notify();
      return;
    }
    this.close();
    const there = spaceFor(path);
    if (there) run("space.select", { id: there.id });
    else run("space.new", { folder: path, name: base(path) });
  }

  render() {
    const t = theme();
    const rows = this.rows();
    this.at = Math.max(0, Math.min(this.at, rows.length - 1));
    const typed = /^[~/]/.test(this.filter.trim());
    const empty =
      this.repos === null
        ? "Looking for projects…"
        : typed
          ? this.missing === this.filter.trim()
            ? "No such folder."
            : "Enter opens this folder."
          : "No project matches.";
    const row = (r, i) =>
      h_flex()
        .id(`pj-${i}`)
        .mx(4)
        .px(10)
        .h(34)
        .rounded(7)
        .gap(10)
        .items_center()
        .cursor_pointer()
        .when(i === this.at, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => cx.spawn((cx) => this.go(r, cx)))
        .child(div().w(12).flex_none().text_color(r.kind === "space" ? t.accent : t.dim).child(r.kind === "space" ? "●" : "○"))
        .child(div().flex_none().max_w(220).truncate().text_color(t.foreground).child(r.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(short(r.path)))
        .when(r.kind === "space", (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child("open")));
    return v_flex()
      .id("projects")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (!rows.length) return;
        if (k === "down") this.at = (this.at + 1) % rows.length;
        else if (k === "up") this.at = (this.at + rows.length - 1) % rows.length;
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        h_flex()
          .items_center()
          .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Open a project"))
          .child(
            div()
              .id("projects-esc")
              .px(6)
              .py(2)
              .rounded(5)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.close())
              .child("Esc"),
          ),
      )
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .gap(8)
          .items_center()
          .rounded(9)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)),
      )
      .child(
        v_flex()
          .id("pj-list")
          .mb(6)
          .when(rows.length === 0, (el) => el.child(div().px(14).py(8).text_size(12).text_color(t.dim).child(empty)))
          .children(rows.map(row)),
      );
  }
}

// projects.json, or the defaults; a broken file is the defaults too.
async function config() {
  try {
    const c = JSON.parse(await readFile(`${appHome()}/projects.json`, "utf8"));
    const list = (v, d) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : d);
    const depth = Number.isInteger(c?.depth) && c.depth >= 1 && c.depth <= 6 ? c.depth : DEFAULTS.depth;
    return { roots: list(c?.roots, DEFAULTS.roots), depth, folders: list(c?.folders, []) };
  } catch {
    return DEFAULTS;
  }
}

// Every repo (a folder with .git, a worktree's file included) under the roots, plus the
// listed folders. A repo inside another one (a submodule, a vendored checkout) is left out.
async function findProjects({ roots, depth, folders }) {
  const found = new Set();
  for (const root of roots) {
    const dir = expand(root);
    const r = await exec("find", [dir, "-mindepth", "2", "-maxdepth", String(depth + 1), "-name", ".git", "-prune"], {
      timeout: 10000,
    }).catch(() => null);
    for (const line of (r?.stdout ?? "").split("\n")) {
      if (line.endsWith("/.git")) found.add(line.slice(0, -5));
    }
  }
  const repos = [...found].sort();
  const top = repos.filter((p) => !repos.some((q) => q !== p && p.startsWith(`${q}/`)));
  for (const f of folders) top.push(expand(f).replace(/\/+$/, ""));
  return [...new Set(top)];
}

// Where a space is now: its shown tab's focused terminal, else its first, else where it
// was made (a space's folder is only where it started).
function liveFolder(space) {
  const shown = space.tabs.find((t) => t.active) ?? space.tabs[0];
  const mine = panes().filter((p) => p.tab === shown?.id && p.cwd);
  return (mine.find((p) => p.focused) ?? mine[0])?.cwd ?? space.folder ?? "";
}

// The space on this computer for a folder: made there, or with a terminal there now.
function spaceFor(path) {
  const mine = spaces().filter((s) => !s.machine);
  const made = mine.find((s) => s.folder === path);
  if (made) return made;
  const inside = (cwd) => cwd === path || cwd?.startsWith(`${path}/`);
  return mine.find((s) => {
    const tabs = new Set(s.tabs.map((t) => t.id));
    return panes().some((p) => tabs.has(p.tab) && inside(p.cwd));
  });
}

// Higher is better, 0 is no match: the name starting with it, then containing it, then
// its letters in order in the name or the path (a fuzzy match, as fzf does).
function score(f, name, path) {
  if (name.startsWith(f)) return 400 - name.length;
  if (name.includes(f)) return 300 - name.length;
  if (inOrder(f, name)) return 200 - name.length;
  if (path.includes(f)) return 150 - path.length / 10;
  if (inOrder(f, path)) return 100 - path.length / 10;
  return 0;
}

function inOrder(f, text) {
  let i = 0;
  for (const c of text) if (c === f[i]) i++;
  return i === f.length;
}

function expand(p) {
  return p === "~" ? home() : p.startsWith("~/") ? `${home()}${p.slice(1)}` : p;
}

function short(p) {
  const h = home();
  return p === h ? "~" : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

function base(p) {
  return p.split("/").filter(Boolean).pop() ?? p;
}

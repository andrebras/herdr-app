// Agents in grouped or priority views; parents take their most urgent sub-agent's place.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, knownAgents, openOverlay, closeOverlay, props, window, layout, checking, exec, nextCommand } from "herdr";
import { PS_ARGS, TMUX_PANE_ARGS, parseProcesses, paneCommands, parseTmuxPanes, parseTmuxClients, focusedTmux, detectedAgents, selectedDetectedAgent } from "./discovery.js";
import { macTerminalDevice, revealTerminalArgs } from "./external.js";

function layoutHasMod(node, mod) {
  return node && !node.hidden && (node.content?.mod === mod || (node.children ?? []).some(child => layoutHasMod(child, mod)));
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// Drops what an agent puts before its title: a status glyph or spinner and the separator
// after it ("✦  Working", "⠋ - Thinking"), and Codex's blinking "[ ! ] " / "[ . ] " mark.
// Stops at an opening bracket or quote, so a title that starts with one ("[web] login") keeps it,
// and at an emoji ("🔴 login", "❤️ deploy"), except for known status marks.
const clean = (s) => (s ?? "").replace(/^(?:\[ [!.] \] |[✋⏳]\uFE0F?(?=\s)|(?!(?:\p{Emoji}\uFE0F|[#*]\u20E3))[^\p{L}\p{N}\p{Ps}\p{Pi}\p{Emoji_Presentation}])+/u, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function liveTitle(l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== (l?.terminal ?? l?.address) && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return telling ? live : null;
}

function title(tab, l) {
  return ((tab.name === l?.program?.name || !tab.named) && liveTitle(l)) || tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
// A kept sub-agent (one with a pane) is in agents() too: it keeps its own status, done included.
const kidStatus = (k, listed) => {
  if (listed.has(k.address)) return listed.get(k.address);
  const s = k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle", 0: "Detected" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu || props()?.agentDetails) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    try { this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}"); } catch { this.changed = {}; }
    if (!this.changed || typeof this.changed !== "object" || Array.isArray(this.changed)) this.changed = {};
    try { this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]"); } catch { this.pendingPins = []; }
    if (!Array.isArray(this.pendingPins)) this.pendingPins = [];
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    try {
      const pins = JSON.parse(localStorage.getItem("tmux.pins") ?? "[]");
      this.tmuxPins = new Set(Array.isArray(pins) ? pins.filter(pin => typeof pin === "string") : []);
    } catch {
      this.tmuxPins = new Set();
    }
    this.scroll = ScrollHandle.new();
    this.processes = new Map();
    this.tmuxPanes = new Map();
    this.tmuxClients = new Map();
    this.nextProcessScan = 0;
    this.paneCommands = "";
    this.tmuxRetry = 0;
    this.nextDiscovery = 0;
    // The app's program table names and draws detected agents, like tracked ones.
    // The New menu keeps the last answer in shared storage, so names show at once.
    this.catalog = new Map((shared("new-menu.agents")?.[""] ?? []).map(p => [p.key, p]));
    this.catalogLoaded = false;
    cx.timer.every(30000, (cx) => cx.notify());
    if (!checking()) {
      const poll = cx => {
        // A hold focus never confirmed (a session that ended) is redrawn when it runs out.
        if (this.navigationPending && Date.now() >= this.navigationPending.until) cx.notify();
        const win = window();
        // tmux and ps are Unix tools; Windows has neither, so nothing is polled there.
        if (!win?.visible || !["linux", "macos"].includes(win.platform) || Date.now() < this.nextDiscovery) return;
        this.nextDiscovery = Date.now() + 1500;
        this.discover(cx);
      };
      poll(cx);
      // Ticks are cheap; discovery runs every 1.5 s, or sooner after a click or key.
      cx.timer.every(250, poll);
      this.loadCatalog(cx);
      // A failed check is not cached, so try again until one answers.
      cx.timer.every(30000, cx => this.loadCatalog(cx));
      cx.spawn(async cx => {
        for (;;) {
          this.navigate(await nextCommand());
          cx.notify();
        }
      });
    }
  }

  navigate(command) {
    const list = this.navigation ?? [];
    if (!list.length) return;
    const index = list.findIndex(a => a.address === this.navigationCurrent);
    const select = /^select-agent-([1-9]\d*)$/.exec(command);
    let target;
    if (command === "next-agent") target = list[(index + 1) % list.length];
    else if (command === "previous-agent") target = list[index < 0 ? list.length - 1 : (index + list.length - 1) % list.length];
    else if (select) target = list[Number(select[1]) - 1];
    if (!target) return;
    this.hold(target.address);
    target.navigate();
  }

  // Focus reaches the list late for tmux rows: show the target as selected at
  // once, hold it until focus confirms it, and look again soon.
  hold(address) {
    this.navigationCurrent = address;
    this.navigationPending = { address, until: Date.now() + 3000 };
    this.nextDiscovery = Math.min(this.nextDiscovery ?? 0, Date.now() + 300);
  }

  followFocus(address, now = Date.now()) {
    const pending = this.navigationPending;
    if (pending && (address === pending.address || now >= pending.until)) this.navigationPending = null;
    this.navigationCurrent = this.navigationPending?.address ?? address;
  }

  discover(cx) {
    if (this.discovering) return;
    this.discovering = true;
    cx.spawn(async cx => {
      try {
        const now = Date.now();
        if (now >= this.tmuxRetry) {
          let result = null;
          try { result = await exec("tmux", TMUX_PANE_ARGS, { timeout: 2000 }); } catch {}
          if (result?.code === 0 || /no server running|error connecting to .*\(No such file or directory\)/.test(result?.stderr ?? "")) {
            // No server means no panes; anything else (no tmux, a hung server)
            // keeps the last panes and waits before asking again.
            const output = result.code === 0 ? result.stdout : "";
            this.tmuxPanes = parseTmuxPanes(output);
            this.tmuxClients = parseTmuxClients(output);
            this.paneCommands = paneCommands(output);
          } else {
            this.tmuxRetry = Date.now() + 15000;
          }
        }
        // Reading every process costs far more than asking tmux, so it runs when
        // a pane's or a terminal's foreground program changes, and every 30 s
        // for agents in other terminal apps.
        const signature = JSON.stringify([this.paneCommands, terminals().map(t => t.foreground?.pid ?? t.pid)]);
        if (now >= this.nextProcessScan || signature !== this.processSignature) {
          this.processSignature = signature;
          let ps = null;
          try { ps = await exec("ps", PS_ARGS, { timeout: 2500 }); } catch {}
          if (ps?.code === 0) this.processes = parseProcesses(ps.stdout);
          // A failed read is tried again soon, so a starting agent isn't missed for 30 s.
          this.nextProcessScan = now + (ps?.code === 0 ? 30000 : 4500);
        }
        const all = terminals();
        const current = focused();
        const active = focusedTmux(this.tmuxClients, all, current?.shown ?? current?.terminal, this.processes);
        const found = detectedAgents(this.processes, this.tmuxPanes, all, panes(), agents(), active);
        const key = JSON.stringify([found, active]);
        if (key !== this.discoveryKey) {
          this.discoveryKey = key;
          cx.notify();
        }
      } finally {
        this.discovering = false;
      }
    });
  }

  focusDetected(agent) {
    const { tmux, pane } = agent;
    const location = tmux?.label || (pane ? "Herdr" : "This computer");
    if (tmux && layoutHasMod(layout(), "spaces")) {
      const suffix = [tmux.server, tmux.session.slice(1), tmux.window.slice(1), tmux.pane.slice(1)].join("-");
      run(`spaces.open-tmux-agent-${suffix}`);
    } else if (!tmux && pane) {
      run("pane.focus", { pane });
    } else {
      openOverlay({ mod: "agents", kind: "dialog", width: 365, height: 220,
        props: { agentDetails: { name: this.programFor(agent.name).name, location, pid: agent.pid, tty: agent.tty, tmux: Boolean(tmux) } } });
    }
  }

  loadCatalog(cx) {
    if (this.catalogLoaded || this.catalogLoading) return;
    this.catalogLoading = true;
    cx.spawn(async cx => {
      try {
        this.catalog = new Map((await knownAgents()).map(p => [p.key, p]));
        this.catalogLoaded = true;
        cx.notify();
      } catch {} finally {
        this.catalogLoading = false;
      }
    });
  }

  programFor(key) {
    return this.catalog.get(key) ?? { key, name: key, icon: "icons/agent.svg", tint: true };
  }

  pinTmux(key, pinned) {
    if (pinned) this.tmuxPins.add(key);
    else this.tmuxPins.delete(key);
    localStorage.setItem("tmux.pins", JSON.stringify([...this.tmuxPins]));
  }

  detectedModel(agent, selected, contexts = new Map(), tmuxCanFocus = true) {
    const tmux = agent.tmux;
    const program = this.programFor(agent.name);
    const tmuxTitle = tmux?.titles?.map(title => liveTitle({ title, program })).find(Boolean);
    const pinKey = tmux?.start ? JSON.stringify([tmux.server, tmux.start, tmux.pane, agent.name]) : null;
    const context = contexts.get(agent.pane);
    const address = `detected-agent-${agent.pid}`;
    // Only a row Herdr can focus waits for focus; one that opens details doesn't.
    const focusable = tmux ? tmuxCanFocus : Boolean(agent.pane);
    const activate = (_e, cx) => {
      if (focusable) this.hold(address);
      this.focusDetected(agent);
      cx?.notify();
    };
    return {
      address, rowId: address, reported: false, focused: agent.pid === selected,
      group: tmux ? `tmux-${tmux.server}-${tmux.session}` : context?.space ?? "local-external",
      groupName: tmux?.label ?? context?.name ?? "This computer",
      spaceName: tmux?.label ?? context?.name ?? program.name,
      title: tmuxTitle || program.name,
      detail: tmux ? tmuxTitle : context ? program.name : agent.tty,
      location: tmux?.position,
      program,
      status: "unknown", rank: 0, since: null, children: [],
      pinned: tmux ? this.tmuxPins.has(pinKey) : Boolean(agent.pinned),
      pin: pinKey ? pinned => this.pinTmux(pinKey, pinned)
        : !tmux && agent.terminal ? pinned => run("terminal.pin", { terminal: agent.terminal, pinned }) : null,
      activate, navigate: focusable ? activate : null,
    };
  }

  reveal(agent, app, cx) {
    if (this.revealing) return;
    const args = revealTerminalArgs(app, agent.tty);
    if (!args) return;
    this.revealing = true;
    this.revealMessage = "Looking for the matching terminal…";
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ps = await exec("/bin/ps", ["-p", String(agent.pid), "-o", "tty="], { timeout: 2000 });
        if (ps.code !== 0 || macTerminalDevice(ps.stdout.trim()) !== macTerminalDevice(agent.tty)) {
          this.revealMessage = "The agent has exited or changed terminals.";
        } else {
          const result = await exec("/usr/bin/osascript", args, { timeout: 30000 });
          if (result.code === 0 && result.stdout.trim() === "revealed") {
            closeOverlay(props().overlay);
            return;
          }
          this.revealMessage = result.code === 0
            ? "No matching tab in that app."
            : "macOS could not switch to that terminal. Check Automation permissions if prompted.";
        }
      } catch {
        this.revealMessage = "Could not open the terminal.";
      } finally {
        this.revealing = false;
        cx.notify();
      }
    });
  }

  agentDetails(t, agent) {
    const button = (id, text, action) => div().id(id).px(9).py(6).rounded(6).bg(t.raised)
      .cursor_pointer().hover(el => el.bg(t.hover)).on_click(action).child(text);
    const reveal = !agent.tmux && window()?.platform === "macos" && Boolean(macTerminalDevice(agent.tty));
    const help = reveal ? "Open the app that owns this terminal."
      : agent.tty ? "Herdr has no pane to open for this agent." : "This process has no interactive terminal.";
    return v_flex().size_full().p(16).gap(9).text_color(t.foreground)
      .child(div().text_size(15).font_semibold().child(agent.name))
      .child(div().text_size(12).text_color(t.muted).child(`${agent.location} · PID ${agent.pid}${agent.tty ? " · " + agent.tty : ""}`))
      .child(div().text_size(12).text_color(t.dim).child(this.revealMessage || help))
      .child(div().flex_1())
      .child(h_flex().gap(8)
        .when(reveal, el => el.child(button("reveal-terminal", "Open in Terminal", (_e, cx) => this.reveal(agent, "terminal", cx)))
          .child(button("reveal-iterm", "Open in iTerm2", (_e, cx) => this.reveal(agent, "iterm", cx))))
        .child(button("agent-details-close", "Close", () => closeOverlay(props().overlay))));
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  rank(a) {
    return RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address)))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "unknown") return div().w(13).flex_none().text_center().text_color(t.dim)
      .text_size(10).child("–");
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    if (props()?.agentDetails) return this.agentDetails(t, props().agentDetails);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    const allPanes = panes();
    const current = focused();
    const tmuxActive = focusedTmux(this.tmuxClients, all, current?.shown ?? current?.terminal, this.processes);
    const detected = detectedAgents(this.processes, this.tmuxPanes, all, allPanes, list, tmuxActive);
    const selected = selectedDetectedAgent(detected, tmuxActive, current?.pane);
    this.migratePins(all);
    const shown = current?.agent;
    const now = Date.now();
    this.track(list, now);
    const byPriority = sort.id === "priority";
    const workspaces = spaces();
    const tabs = new Map();
    for (const space of workspaces) {
      for (const tab of space.tabs) tabs.set(tab.id, { tab, space: space.id, name: space.name });
    }
    const contexts = new Map(allPanes.map(p => [p.pane, tabs.get(p.tab)]));
    const leads = leadPanes(allPanes);
    const tabCounts = new Map();
    const trees = new Map();
    const nested = new Set();
    for (const agent of list) {
      const children = this.tree(all, agent.address);
      trees.set(agent.address, children);
      if (!collapsed) for (const child of children) nested.add(child.t.address);
    }
    list = list.filter(a => a.pinned || !nested.has(a.address));
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const native = list.map(a => {
      const context = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      const label = context ? title(many ? { ...context.tab, named: false } : context.tab, many ? a : leads.get(a.tab))
        : a.title || a.program?.name || "";
      const children = trees.get(a.address);
      const rank = Math.max(this.rank(a), ...children.map(({ t }) => {
        const status = kidStatus(t, this.listed);
        return RANK[status === "done" ? "idle" : status] ?? 0;
      }));
      return {
        address: a.address, rowId: "ag-" + a.address, reported: true,
        group: a.space, groupName: a.space_name, spaceName: a.space_name,
        title: label, detail: /^\d+$/.test(label) ? null : label,
        status: a.status, since: this.since(a), rank: rank || RANK.idle, seq: a.seq,
        program: a.program, focused: a.focused,
        machine: a.address.includes("/") ? a.address.split("/")[0] : null,
        pinned: a.pinned, pin: pinned => run("terminal.pin", { terminal: a.address, pinned }),
        activate: () => { this.navigationPending = null; run("pane.focus", { pane: a.pane }); },
        navigate: () => run("agent.focus", { terminal: a.address }),
        children: collapsed ? [] : children,
      };
    });
    const counts = new Map();
    for (const a of native) {
      const key = JSON.stringify([a.spaceName, a.detail]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const a of native) {
      if (a.detail == null && counts.get(JSON.stringify([a.spaceName, null])) > 1) a.detail = a.title;
    }
    const tmuxCanFocus = layoutHasMod(layout(), "spaces");
    const discovered = detected.map(agent => this.detectedModel(agent, selected, contexts, tmuxCanFocus));
    if (discovered.some(a => a.focused)) for (const a of native) {
      if (a.address === (current?.shown ?? current?.terminal)) a.focused = false;
    }
    const combined = [...native, ...discovered];
    if (byPriority) combined.sort((a, b) => b.rank - a.rank || (b.since ?? 0) - (a.since ?? 0) || (b.seq ?? 0) - (a.seq ?? 0));
    const pinned = combined.filter(a => a.pinned);
    const section = new Map();
    for (const a of combined) {
      if (a.pinned) continue;
      const id = byPriority ? (a.rank === 0 ? "detected-agents" : "sec-" + a.rank) : "sp-" + a.group;
      if (!section.has(id)) section.set(id, {
        id, label: byPriority ? SECTION[a.rank] : a.groupName || "",
        status: byPriority ? SECTION_STATUS[a.rank] : null, members: [],
      });
      section.get(id).members.push(a);
    }
    const groups = [...section.values()];
    if (pinned.length) groups.unshift({ id: "pinned", label: "Pinned", status: null, members: pinned });
    const ordered = groups.flatMap(g => g.members);
    this.navigation = ordered.filter(a => a.navigate);
    this.followFocus(this.navigation.find(a => a.focused)?.address ?? shown, now);
    if (this.navigationPending) for (const a of ordered) a.focused = a.address === this.navigationPending.address;
    const navigationIndices = new Map(this.navigation.map((a, i) => [a.address, i + 1]));
    setAgentOrder(ordered.filter(a => a.reported).map(a => a.address),
      this.navigation.some(a => !a.reported) ? this.navigation.length : undefined);

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    const row = (a) => {
      const subs = a.children;
      const pic = icon(a.program, 16, t.foreground);
      const more = a.detail;
      const tooltip = [a.program?.name, a.spaceName, more, a.location, a.status === "unknown" ? "Status unavailable" : null].filter(Boolean).join(" · ");
      if (collapsed) {
        return h_flex()
          .id(a.rowId)
          .h(26)
          .mx(6)
          .px(2)
          .rounded(6)
          .flex_none()
          .items_center()
          .gap(4)
          .when(a.focused, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(a.activate)
          .when(Boolean(tooltip), el => el.tooltip(tooltip))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(a.focused ? t.foreground : t.muted)
            .child(navigationIndices.has(a.address) ? String(navigationIndices.get(a.address)) : pic))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = a.since;
      const muted = (a.status === "idle" || a.status === "unknown") && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          a.pin(!isPinned);
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.spaceName || a.title : more ?? (/^\d+$/.test(a.title) ? a.program?.name || a.title : a.title);
      return h_flex()
        .id(a.rowId)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(a.activate)
        .when(Boolean(tooltip), el => el.tooltip(tooltip))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(muted ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(a.machine), el => el.child(div().text_size(10).text_color(t.dim).child(a.machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(Boolean(a.pin) && this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .when(!open && g.selected, el => el.bg(t.selected))
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    let selectedAt = -1;
    const rows = [];
    const add = (a) => {
      if (a.focused) selectedAt = rows.length;
      rows.push(row(a));
      if (!this.folded.has(a.address)) rows.push(...a.children.map(child => this.subRow(t, child, shown, byPriority)));
    };
    if (collapsed) {
      ordered.forEach(add);
    } else {
      for (const group of groups) {
        const folded = this.folded.has(group.id);
        group.selected = group.members.some(a => a.focused);
        if (group.selected && folded) selectedAt = rows.length;
        rows.push(header(group));
        if (!folded) group.members.forEach(add);
      }
    }
    const selection = ordered.find(a => a.focused)?.address;
    if (selection !== this.selectedAddress || selectedAt !== this.selectedAt) {
      this.selectedAddress = selection;
      this.selectedAt = selectedAt;
      if (selectedAt >= 0) this.scroll.scroll_to_item(selectedAt);
    }

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "agents", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && detected.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agents detected yet.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").track_scroll(this.scroll).children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}

import { test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseProcesses, paneCommands, parseTmuxPanes, parseTmuxClients, focusedTmux, detectedAgents, selectedDetectedAgent } from "../defaults/mods/agents/discovery.js";
import { macTerminalDevice, revealTerminalArgs } from "../defaults/mods/agents/external.js";

const source = (await readFile(new URL("../defaults/mods/agents/main.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replace("export default class Agents", "class Agents");

function harness(pins: string[], overrides: Record<string, unknown> = {}) {
  const { checking = () => true, ...rest } = overrides;
  const globals = { focusedTmux, detectedAgents, selectedDetectedAgent, macTerminalDevice, revealTerminalArgs,
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) }, ...rest };
  const data = new Map([["pins", JSON.stringify(pins)]]);
  const writes: unknown[] = [];
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) };
  const Agents = new Function("View", "localStorage", "props", "run", "checking", ...Object.keys(globals), `${source}; return Agents;`)(
    class {}, storage, () => ({}), (...args: unknown[]) => writes.push(args),
    checking, ...Object.values(globals),
  );
  const agents = new Agents();
  agents.init({}, { timer: { every() {} }, spawn: (fn: (cx: unknown) => unknown) => fn({ notify() {} }) });
  return { agents, data, writes };
}

test("legacy pins migrate once listed, retaining offline pins until their labels arrive", () => {
  const { agents, data, writes } = harness(["t1", "offline/t2"]);
  agents.migratePins([]);
  expect(JSON.parse(data.get("pins")!)).toEqual(["t1", "offline/t2"]);
  const local = { address: "t1", state: "live", labels: {} };
  agents.migratePins([local]);
  agents.migratePins([local]);
  expect(writes).toEqual([["terminal.pin", { terminal: "t1", pinned: true }]]);
  expect(JSON.parse(data.get("pins")!)).toEqual(["t1", "offline/t2"]);
  agents.migratePins([{ ...local, labels: { "herdr.pinned": "1" } }]);
  expect(JSON.parse(data.get("pins")!)).toEqual(["offline/t2"]);
  const remote = { address: "offline/t2", state: "live", labels: {} };
  agents.migratePins([remote]);
  expect(writes).toHaveLength(2);
  agents.migratePins([{ ...remote, labels: { "herdr.pinned": "1" } }]);
  expect(data.has("pins")).toBe(false);
});

test("already shared pins need no write and pending writes survive restart", () => {
  expect(harness([]).data.has("pins")).toBe(false);
  const { agents, data, writes } = harness(["t1"]);
  agents.migratePins([{ address: "t1", state: "live", labels: { "herdr.pinned": "1" } }]);
  expect(writes).toHaveLength(0);
  expect(data.has("pins")).toBe(false);
  const retry = harness(["t2"]);
  retry.agents.migratePins([{ address: "t2", state: "live", labels: {} }]);
  expect(JSON.parse(retry.data.get("pins")!)).toEqual(["t2"]);
  const restarted = harness(JSON.parse(retry.data.get("pins")!));
  restarted.agents.migratePins([{ address: "t2", state: "live", labels: {} }]);
  expect(restarted.writes).toHaveLength(1);
});

test("an unnamed tab's row reads its terminal's title, not the tab number", () => {
  const title = new Function("View", "localStorage", "props", "run", `${source}; return title;`)(class {}, {}, () => ({}), () => {});
  const claude = { program: { name: "claude", key: "claude" }, title: "Herdr session names" };
  expect(title({ name: "3", named: false }, claude)).toBe("Herdr session names");
  expect(title({ name: "claude", named: true }, claude)).toBe("Herdr session names");
  expect(title({ name: "fix login", named: true }, claude)).toBe("fix login");
  expect(title({ name: "3", named: false }, { ...claude, title: "claude" })).toBe("3");
});

test("an empty OSC title published as the terminal address keeps the tab name", () => {
  const title = new Function("View", `${source}; return title;`)(class {});
  for (const address of ["t2", "remote/t2"]) {
    for (const identity of [{ terminal: address }, { address }]) {
      const lead = { ...identity, program: { name: "Claude Code", key: "claude" }, title: address };
      expect(title({ name: "2", named: false }, lead)).toBe("2");
      expect(title({ name: "Claude Code", named: true }, lead)).toBe("Claude Code");
      expect(title({ name: "fix login", named: true }, lead)).toBe("fix login");
      expect(title({ name: "2", named: false }, { ...lead, title: "renamed-task" })).toBe("renamed-task");
    }
  }
});

test("a title that is a folder never replaces the tab's name", () => {
  const title = new Function("View", "localStorage", "props", "run", `${source}; return title;`)(class {}, {}, () => ({}), () => {});
  const claude = { program: { name: "claude", key: "claude" }, title: "Herdr session names" };
  expect(title({ name: "3", named: false }, { ...claude, title: "~/src/api" })).toBe("3");
  expect(title({ name: "3", named: false }, { ...claude, title: "/tmp" })).toBe("3");
  expect(title({ name: "3", named: false }, { ...claude, title: "\u2733 ~/src/api" })).toBe("3");
  expect(title({ name: "3", named: false }, { ...claude, title: "C:\\src\\api" })).toBe("3");
  expect(title({ name: "3", named: false }, { ...claude, title: "\u2733 Herdr session names" })).toBe("Herdr session names");
});

test("tab labels prefer the first agent, then focused terminal, then first terminal", () => {
  const leadPanes = new Function("View", `${source}; return leadPanes;`)(class {});
  const pane = (tab: string, terminal: string, agent = false, focused = false) => ({ tab, terminal, program: { agent }, focused });
  const all = [
    { tab: "agent", focused: true }, // A mod pane has no terminal.
    pane("agent", "shell", false, true), pane("agent", "first-agent", true), pane("agent", "second-agent", true, true),
    pane("focused", "first-shell"), pane("focused", "focused-shell", false, true),
    pane("first", "first"), pane("first", "second"),
  ];
  const leads = leadPanes(all);
  expect([...leads].map(([tab, p]: any) => [tab, p.terminal])).toEqual([
    ["agent", "first-agent"], ["focused", "focused-shell"], ["first", "first"],
  ]);
});

// Lightweight element descriptions: execute conditional builders and retain text,
// without running input callbacks or pretending to exercise native GPUI layout.
function element() {
  const node = { id: "", children: [] as any[] };
  const el: any = new Proxy(node, { get: (_, method) => {
    if (method === "node") return node;
    return (...args: any[]) => {
      if (method === "id") node.id = args[0];
      if (method === "on_click") (node as any).click = args[0];
      if (method === "bg") (node as any).bg = args[0];
      if (method === "tooltip") (node as any).tooltip = args[0];
      if (method === "text_color") (node as any).color = args[0];
      if (method === "child") node.children.push(args[0]?.node ?? args[0]);
      if (method === "children") node.children.push(...args[0].map((child: any) => child?.node ?? child));
      if (method === "when" && args[0]) args[1](el);
      return el;
    };
  } });
  return el;
}
function textOf(node: any): string {
  return typeof node === "string" ? node : (node?.children ?? []).map(textOf).join(" ");
}

test("a failed agent check keeps cached launchable agents and shows an error instead of missing agents", async () => {
  const menuSource = (await readFile(new URL("../defaults/mods/new-menu/main.js", import.meta.url), "utf8"))
    .replace(/^import .*;\n/gm, "").replace("export default class NewMenu", "class NewMenu");
  const cached = [
    { key: "claude", name: "Claude Code", run: ["claude"], installed: true },
    { key: "codex", name: "Codex", run: ["codex"], installed: false },
  ];
  for (const agents of [[], cached]) {
    const writes: unknown[] = [];
    const globals = {
      View: class {}, spaces: () => [], shared: () => ({ "": agents }), setShared: (...args: unknown[]) => writes.push(args),
      knownAgents: async () => { throw Error("shell failed"); },
      theme: () => ({}), props: () => ({}), keys: () => [], window: () => ({ platform: "macos" }), panes: () => [],
      div: element, svg: element, image: element, h_flex: element, v_flex: element,
    };
    const NewMenu = new Function(...Object.keys(globals), `${menuSource}; return NewMenu;`)(...Object.values(globals));
    const menu = new NewMenu();
    let task: Promise<void>;
    menu.init({}, { focus_handle: () => ({ focus() {} }), spawn: (run: (cx: unknown) => Promise<void>) => { task = run({ notify() {} }); } });
    await task!;
    const text = textOf(menu.render().node);
    expect(text).toContain("Could not check installed agents");
    expect(text).not.toContain("not installed");
    expect(text).not.toContain("Codex");
    if (agents.length) expect(text).toContain("Claude Code");
    expect(writes).toEqual([]);
  }
});

for (const sort of ["priority", "grouped"]) test(`${sort} render reads panes once and refreshes labels on the next render`, () => {
  const list = Array.from({ length: 64 }, (_, i) => ({
    address: `t${i}`, pane: `p${i}`, tab: `tab${i}`, space: "s1", space_name: "Project",
    program: { name: "Claude", key: "claude", agent: true }, title: "Fallback", status: "idle", seq: i,
  }));
  const snapshot = list.map((a, i) => ({ tab: a.tab, terminal: a.address, program: a.program, title: `Task ${i}` }));
  let reads = 0;
  const orders: string[][] = [];
  const { agents } = harness([], {
    agents: () => list, terminals: () => list.map(a => ({ ...a, state: "live" })),
    panes: () => { reads++; return structuredClone(snapshot); }, focused: () => null,
    spaces: () => [{ tabs: list.map(a => ({ id: a.tab, name: "Claude", named: true })) }],
    layout: () => ({ id: "sidebar", size: { px: 268 } }), shared: () => sort,
    theme: () => ({}), setAgentOrder: (order: string[]) => orders.push(order),
    div: element, v_flex: element, h_flex: element, svg: element, image: element,
  });
  const first = textOf(agents.render({}).node);
  expect(reads).toBe(1);
  for (let i = 0; i < list.length; i++) expect(first).toContain(`Task ${i}`);
  expect(orders[0]).toHaveLength(list.length);
  snapshot[63].title = "Updated task";
  const second = textOf(agents.render({}).node);
  expect(reads).toBe(2);
  expect(second).toContain("Updated task");
  expect(second).not.toContain("Task 63");
  expect(orders[1]).toEqual(orders[0]);
});

for (const sort of ["priority", "grouped"]) for (const named of [false, true]) test(`${sort}: agents sharing a ${named ? "named" : "numbered"} tab keep their own titles`, () => {
  const program = { name: "Claude", key: "claude", agent: true };
  let list = ["Alpha task", "Beta task", "Solo task"].map((title, i) => ({
    address: `t${i}`, pane: `p${i}`, tab: i < 2 ? "shared" : "solo", space: "s1", space_name: "Project",
    program, title, status: "idle", seq: i,
  }));
  const { agents } = harness([], {
    agents: () => list, terminals: () => list.map(a => ({ ...a, state: "live" })),
    panes: () => list.map(a => ({ ...a, terminal: a.address })), focused: () => null,
    spaces: () => [{ tabs: [{ id: "shared", name: named ? "Named tab" : "1", named }, { id: "solo", name: "Solo tab", named: true }] }],
    layout: () => ({ id: "sidebar", size: { px: 268 } }), shared: () => sort,
    theme: () => ({}), setAgentOrder() {},
    div: element, v_flex: element, h_flex: element, svg: element, image: element,
  });
  const rows = () => {
    const result = new Map<string, string>();
    const walk = (node: any) => {
      if (node?.id?.startsWith("ag-t")) result.set(node.id, textOf(node));
      (node?.children ?? []).forEach(walk);
    };
    walk(agents.render({}).node);
    return result;
  };
  const shared = rows();
  expect(shared.get("ag-t0")).toContain("Alpha task");
  expect(shared.get("ag-t1")).toContain("Beta task");
  expect(shared.get("ag-t1")).not.toContain("Alpha task");
  expect(shared.get("ag-t0")).not.toContain("Named tab");
  expect(shared.get("ag-t2")).toContain("Solo tab");
  expect(shared.get("ag-t2")).not.toContain("Solo task");
  list = list.filter(a => a.address !== "t1");
  expect(rows().get("ag-t0")).toContain(named ? "Named tab" : "Alpha task");
});

// A kept sub-agent: started by t1 (`hc run`), then given a pane (`terminal.keep`).
function keptRender(sort: string, { width = 268, kept = [{ address: "t3", parent: "t1" }], paneless = [] as { address: string; parent: string }[], pinned = [] as string[], statuses = {} as Record<string, string>, others = [] as string[] } = {}) {
  const program = { name: "Claude", key: "claude", agent: true };
  const status = (address: string) => statuses[address] ?? "working";
  const row = (address: string, seq: number) => ({ address, pane: `p-${address}`, tab: "tab1", space: "s1", space_name: "Project", program, title: `Task ${address}`, status: status(address), seq, pinned: pinned.includes(address) });
  const list = [row("t1", 1), ...kept.map((k, i) => row(k.address, i + 2)), ...others.map((a, i) => row(a, i + 10))];
  const live = (address: string, parent: string | null) => ({ address, parent, state: "live", status: status(address), program, labels: {} });
  const orders: string[][] = [];
  const { agents, writes } = harness([], {
    agents: () => list,
    terminals: () => [live("t1", null), ...others.map(a => live(a, null)), ...paneless.map(k => live(k.address, k.parent)), ...kept.map(k => live(k.address, k.parent))],
    panes: () => list.map(a => ({ tab: a.tab, terminal: a.address, program, title: a.title })), focused: () => null,
    spaces: () => [{ tabs: [{ id: "tab1", name: "Project", named: true }] }],
    layout: () => ({ id: "sidebar", size: { px: width } }), shared: () => sort,
    theme: () => ({}), setAgentOrder: (order: string[]) => orders.push(order),
    div: element, v_flex: element, h_flex: element, svg: element, image: element,
  });
  const ids: string[] = [];
  const clicks = new Map<string, () => void>();
  const texts = new Map<string, string>();
  const walk = (node: any) => {
    if (node?.id) { ids.push(node.id); texts.set(node.id, textOf(node)); if (node.click) clicks.set(node.id, node.click); }
    (node?.children ?? []).forEach(walk);
  };
  walk(agents.render({}).node);
  return { ids, clicks, writes, texts, order: orders[orders.length - 1] };
}

for (const sort of ["priority", "grouped"]) test(`${sort}: a kept sub-agent shows once, under its parent, and its row focuses its pane`, () => {
  const { ids, clicks, writes, texts, order } = keptRender(sort);
  expect(texts.get("ag-t1")).toContain("Project");
  expect(texts.get("ag-t1")).not.toContain("t1");
  expect(texts.get("sub-t3")).toContain("Claude");
  expect(texts.get("sub-t3")).not.toContain("Project");
  expect(ids).toContain("ag-t1");
  expect(ids).toContain("sub-t3");
  expect(ids).not.toContain("ag-t3");
  expect(order).toEqual(["t1"]);
  clicks.get("sub-t3")!();
  expect(writes).toContainEqual(["pane.focus", { terminal: "t3" }]);
});

for (const sort of ["priority", "grouped"]) test(`${sort}: a kept sub-agent under a pane-less one shows once in the tree`, () => {
  const { ids } = keptRender(sort, { paneless: [{ address: "t3", parent: "t1" }], kept: [{ address: "t4", parent: "t3" }] });
  expect(ids).toContain("sub-t3");
  expect(ids).toContain("sub-t4");
  expect(ids).not.toContain("ag-t4");
});

for (const sort of ["priority", "grouped"]) test(`${sort}: a kept sub-agent keeps its own row where no tree shows it`, () => {
  expect(keptRender(sort, { width: 44 }).ids).toContain("ag-t3"); // the rail draws no trees
  const pinned = keptRender(sort, { pinned: ["t3"] });
  expect(pinned.ids).toContain("ag-t3");
  expect(pinned.texts.get("ag-t1")).toContain("Task t1");
  expect(pinned.texts.get("ag-t3")).toContain("Task t3");
  expect(keptRender(sort, { kept: [{ address: "t3", parent: "t9" }] }).ids).toContain("ag-t3"); // its parent ended
});

test("a kept sub-agent's done doesn't pull its working parent above other working agents", () => {
  const { order, texts } = keptRender("priority", { statuses: { t3: "done" }, others: ["t5"] });
  expect(order).toEqual(["t5", "t1"]);
  expect(texts.get("sub-t3")).toBeDefined();
});

test("a kept sub-agent keeps its own done status; a pane-less one stays idle", () => {
  const kidStatus = new Function("View", `${source}; return kidStatus;`)(class {});
  const listed = new Map([["t3", "done"]]);
  expect(kidStatus({ address: "t3", status: "done" }, listed)).toBe("done");
  expect(kidStatus({ address: "t4", status: "done" }, listed)).toBe("idle");
  expect(kidStatus({ address: "t4", status: "error" }, listed)).toBe("blocked");
  expect(kidStatus({ address: "t4", status: "working" }, listed)).toBe("working");
});

for (const width of [268, 44]) test(`the focused agent's row is marked as selected ${width < 160 ? "in the rail" : "in the wide list"}`, () => {
  const program = { name: "Claude", key: "claude", agent: true };
  const list = ["t1", "t2"].map((address, i) => ({
    address, pane: `p-${address}`, tab: address, space: "s1", space_name: "Project",
    program, title: address, status: "idle", seq: i, focused: address === "t2",
  }));
  const { agents } = harness([], {
    agents: () => list, terminals: () => list.map(a => ({ ...a, state: "live", labels: {} })),
    panes: () => list.map(a => ({ ...a, terminal: a.address })), focused: () => ({ agent: "t2" }),
    spaces: () => [{ tabs: list.map(a => ({ id: a.tab, name: a.address, named: true })) }],
    layout: () => ({ id: "sidebar", size: { px: width } }), shared: () => "grouped",
    theme: () => ({ selected: "selected", hover: "hover" }), setAgentOrder() {},
    div: element, v_flex: element, h_flex: element, svg: element, image: element,
  });
  const fills = new Map<string, unknown>();
  const walk = (node: any) => {
    if (node?.id?.startsWith("ag-t")) fills.set(node.id, node.bg);
    (node?.children ?? []).forEach(walk);
  };
  walk(agents.render({}).node);
  expect([...fills]).toEqual([["ag-t1", undefined], ["ag-t2", "selected"]]);
});

test("a title that opens with a bracket keeps it; each agent's own prefix still goes", () => {
  const title = new Function("View", "localStorage", "props", "run", `${source}; return title;`)(class {}, {}, () => ({}), () => {});
  const clean = new Function("View", "localStorage", "props", "run", `${source}; return clean;`)(class {}, {}, () => ({}), () => {});
  const claude = { program: { name: "claude", key: "claude" }, title: "" };
  // The reported bug: a Claude Code session renamed "[herdr] config" showed as "herdr] config".
  expect(title({ name: "3", named: false }, { ...claude, title: "[herdr] config" })).toBe("[herdr] config");
  // Titles as each agent writes them (from its source).
  const titles: [string, string][] = [
    ["[herdr] config", "[herdr] config"], // Claude Code: the session name
    ["⠋ [herdr] config | herdr-app", "[herdr] config | herdr-app"], // Codex working
    ["[ ! ] Action Required | [herdr] config | herdr-app", "Action Required | [herdr] config | herdr-app"], // Codex needs you
    ["[ . ] Action Required | [herdr] config | herdr-app", "Action Required | [herdr] config | herdr-app"], // ... its other blink phase
    ["● [ ! ] Action Required | herdr-app", "Action Required | herdr-app"], // ... with the microphone on
    ["✦  [herdr] config (herdr-app)", "[herdr] config (herdr-app)"], // Gemini working
    ["◇  Ready (herdr-app)", "Ready (herdr-app)"], // Gemini idle
    ["OC | [herdr] config", "OC | [herdr] config"], // OpenCode
    ["π - [herdr] config - herdr-app", "π - [herdr] config - herdr-app"], // Pi
    ["⠋ - Thinking - [herdr] config - grok", "Thinking - [herdr] config - grok"], // Grok: the spinner's " - " goes too
  ];
  for (const [raw, shown] of titles) expect(clean(raw)).toBe(shown);
});

test("a title's leading emoji stays, a status glyph before it goes", () => {
  const title = new Function("View", "localStorage", "props", "run", `${source}; return title;`)(class {}, {}, () => ({}), () => {});
  const row = (t: string) => title({ name: "3", named: false }, { program: { name: "claude", key: "claude" }, title: t });
  for (const e of ["🔴", "🟦", "✅", "❌", "⭐", "🚀", "🧠", "⚪", "🇰🇷", "👍🏽", "👨\u200d💻", "❤️", "⚙️", "#️⃣", "✋🏽"]) expect(row(`${e} login`)).toBe(`${e} login`);
  expect(row("\u2733 🟢 login")).toBe("🟢 login");
  expect(row("[ ! ] 🔴 login")).toBe("🔴 login");
  expect(row("\u25cf [ ! ] 🔴 login")).toBe("🔴 login");
  expect(row("\u2733 login")).toBe("login");
  expect(row("\u280b - Thinking")).toBe("Thinking");
  expect(row("✋  Action Required (proj)")).toBe("Action Required (proj)");
  expect(row("⏳  ❤️ deploy")).toBe("❤️ deploy");
  // A folder is still a folder behind its emoji.
  expect(row("🔴 ~/proj")).toBe("3");
  // An emoji is a name a person chose: alone, or beside the program's name, it is the row's name.
  expect(row("🔴")).toBe("🔴");
  expect(row("🔴 claude")).toBe("🔴 claude");
});

test("links detected processes to the current tmux session and identifies the selected pane", () => {
  const processes = parseProcesses([
    "10 1 pts/0 /bin/zsh",
    "20 10 pts/0 node /opt/bin/codex",
    "21 20 pts/0 /opt/bin/codex",
    "30 1 s003 claude --resume",
    "31 1 ?? claude",
    "32 1 ?? bash -c echo claude",
  ].join("\n"));
  const output = [
    "900\t$0\t@3\t%4\t10\t0\tdataforge\t1\t0\tReview",
    "900\t$2\t@3\t%4\t10\t0\tlinked\t2\t1\tReview",
    "900\t$2\t@8\t%9\t30\t1\tdead\t3\t0\tDead",
    "client\t55\t900\t$2\t%4\t@3",
  ].join("\n");
  const terminals = [{ address: "t1", pid: 54, foreground: { pid: 55 } }, { address: "t2", pid: 31, status: "idle" }];
  const selected = focusedTmux(parseTmuxClients(output), terminals, "t1");
  expect(selected).toEqual({ server: "900", session: "$2", pane: "%4", window: "@3" });
  expect(focusedTmux(parseTmuxClients(output), terminals, "remote/t1")).toBeNull();
  const found = detectedAgents(processes, parseTmuxPanes(output), terminals, [], [{ address: "t2" }], selected);
  expect(found.map(agent => [agent.pid, agent.name, agent.tmux?.label, agent.tmux?.titles, agent.tmux?.position, agent.tty])).toEqual([
    [20, "codex", "linked", ["Review"], "2.1", "pts/0"],
    [30, "claude", undefined, undefined, undefined, "s003"],
  ]);
});

test("tmux navigation targets the exact pane, and external rows open details", () => {
  const overlays: any[] = [];
  const { agents, writes } = harness([], {
    layout: () => ({ content: { mod: "spaces" } }),
    openOverlay: (overlay: unknown) => overlays.push(overlay),
    div: element, h_flex: element, svg: element, image: element,
  });
  const target = { server: "900", session: "$2", window: "@3", pane: "%4", label: "dataforge", titles: ["Review"], position: "2.1" };
  agents.navigation = [{ address: "t1", navigate: () => writes.push(["agent.focus", { terminal: "t1" }]) },
    agents.detectedModel({ pid: 20, name: "Codex", tmux: target }, null)];
  agents.navigate("next-agent");
  agents.navigate("next-agent");
  agents.navigate("select-agent-1");
  expect(writes).toEqual([["agent.focus", { terminal: "t1" }], ["spaces.open-tmux-agent-900-2-3-4"], ["agent.focus", { terminal: "t1" }]]);
  agents.focusDetected({ pid: 30, name: "Claude Code", tty: "s003" });
  expect(overlays[0].props.agentDetails).toEqual({ pid: 30, name: "Claude Code", location: "This computer", tty: "s003", tmux: false });
});

test("revealing a Mac terminal uses a validated terminal device argument", () => {
  expect(macTerminalDevice("s003")).toBe("/dev/ttys003");
  expect(macTerminalDevice("/dev/ttys003")).toBe("/dev/ttys003");
  expect(revealTerminalArgs("terminal", "??")).toBeNull();
  expect(revealTerminalArgs("terminal", "s003; whoami")).toBeNull();
  expect(revealTerminalArgs("iterm", "s003")?.at(-1)).toBe("/dev/ttys003");
});

test("a Spaces switch highlights the agent even when tmux is focused on the window's side pane", () => {
  const processes = parseProcesses([
    "55 54 s001 tmux attach",
    "61 1 s010 /bin/zsh",
    "62 61 s010 claude --resume",
    "71 1 s011 /bin/zsh",
    "72 71 s011 codex",
  ].join("\n"));
  const panes = parseTmuxPanes([
    "900\t$0\t@1\t%4\t61\t0\tdataforge\t1\t0\tReview",
    "900\t$1\t@2\t%6\t71\t0\trevolution\t1\t0\tBuild",
  ].join("\n"));
  const terminals = [{ address: "t1", pid: 54 }];
  const reveal: number[] = [];
  const { agents } = harness([], {
    agents: () => [], terminals: () => terminals, panes: () => [], spaces: () => [],
    focused: () => ({ terminal: "t1", pane: "p1" }),
    layout: () => ({ id: "sidebar", size: { px: 268 } }), shared: () => null,
    theme: () => ({ selected: "#selected" }), setAgentOrder() {},
    div: element, v_flex: element, h_flex: element, svg: element, image: element,
    ScrollHandle: { new: () => ({ scroll_to_item: (i: number) => reveal.push(i) }) },
  });
  agents.processes = processes;
  agents.tmuxPanes = panes;
  const selected = () => {
    const rows = new Map<string, string>();
    function walk(node: any) {
      if (node?.id?.startsWith("detected-agent-")) rows.set(node.id, node.bg);
      node?.children?.forEach(walk);
    }
    walk(agents.render({}).node);
    return [...rows].filter(([, bg]) => bg === "#selected").map(([id]) => id);
  };
  agents.tmuxClients = parseTmuxClients("client\t55\t900\t$0\t%4\t@1");
  expect(selected()).toEqual(["detected-agent-62"]);
  agents.tmuxClients = parseTmuxClients("client\t55\t900\t$1\t%7\t@2");
  expect(selected()).toEqual(["detected-agent-72"]);
  expect(selected()).toEqual(["detected-agent-72"]);
  expect(reveal).toEqual([1, 2]);
});

test("agent selection prefers the active pane then an unambiguous window or session", () => {
  const agent = (pid: number, session: string, window: string, pane: string) => ({ pid, tmux: { server: "900", session, window, pane } });
  const found = [agent(1, "$0", "@2", "%1"), agent(2, "$0", "@2", "%2"), agent(3, "$0", "@3", "%3"), agent(4, "$1", "@4", "%4")];
  const active = (session: string, window: string, pane: string | null) => ({ server: "900", session, window, pane });
  expect(selectedDetectedAgent(found, active("$0", "@2", "%1"), null)).toBe(1);
  expect(selectedDetectedAgent(found, active("$0", "@2", "%9"), null)).toBeUndefined();
  expect(selectedDetectedAgent(found, active("$0", "@3", null), null)).toBe(3);
  expect(selectedDetectedAgent(found, active("$1", "@9", "%9"), null)).toBe(4);
  expect(selectedDetectedAgent(found, active("$9", "@9", "%9"), null)).toBeUndefined();
});

test("process names come from args, so spaces inside args don't shift the columns", () => {
  const processes = parseProcesses([
    "40 1 s001 claude --model  opus",
    "41 1 s002 node  /opt/lib/codex.js  --full-auto",
    "42 1 s003 /Applications/My Tools/claude helper",
    "43 1 s004 /Users/me/.local/bin/claude",
  ].join("\n"));
  expect([...processes].map(([pid, p]) => [pid, p.name])).toEqual([
    [40, "claude"], [41, "codex"], [42, null], [43, "claude"],
  ]);
});

test("headless processes disappear and tracked interactive agents are deduped by process identity", () => {
  const ps = parseProcesses([
    "10 1 s010 claude",
    "11 1 s011 claude",
    "12 1 ?? codex",
  ].join("\n"));
  const snapshot = [
    "900\t$1\t@2\t%4\t10\t0\tProject\t1\t0\t2.1.311\tReview queue\t99",
    "900\t$1\t@2\t%5\t11\t0\tProject\t1\t1\t2.1.311\tClaude Code\t99",
  ].join("\n");
  const terminal = [{ address: "t1", foreground: { pid: 10 }, status: "idle" }];
  const found = detectedAgents(ps, parseTmuxPanes(snapshot), terminal, [], [{ address: "t1" }]);
  expect(found.map(a => a.pid)).toEqual([11]);
  expect(found[0].tmux?.titles).toEqual([]);
  expect(found[0].tmux?.position).toBe("1.1");
  expect(parseTmuxPanes(snapshot).get(10)?.[0].titles).toEqual(["Review queue"]);
});

test("pinning a detected agent persists the pane target across view reloads", () => {
  const { agents, data, writes } = harness([]);
  const process = { pid: 20, name: "Codex", tmux: { server: "900", start: "99", pane: "%4" } };
  const row = agents.detectedModel(process, null);
  expect(row.pinned).toBe(false);
  row.pin(true);
  const reloaded = harness([]);
  reloaded.data.set("tmux.pins", data.get("tmux.pins")!);
  reloaded.agents.init({}, { timer: { every() {} } });
  const samePane = reloaded.agents.detectedModel({ ...process, pid: 21 }, null);
  expect(samePane.pinned).toBe(true);
  expect(reloaded.agents.detectedModel({ ...process, tmux: { ...process.tmux, start: "100" } }, null).pinned).toBe(false);
  samePane.pin(false);
  expect(reloaded.agents.detectedModel(process, null).pinned).toBe(false);
  expect(writes).toEqual([]);
});

test("tracked and tmux agents share selection, row activation, and the same pin control", () => {
  let pane = { terminal: "t1", pane: "p1", tab: "tab1" };
  const stock = { address: "t1", tab: "tab1", pane: "p1", space: "s1", space_name: "Project",
    focused: true, status: "idle", pinned: false, seq: 1, program: { name: "Claude Code", icon: "icons/claude.svg" } };
  const reported = [stock];
  const { agents, writes, data } = harness([], {
    agents: () => reported, terminals: () => [{ address: "tmux", pid: 55 }], panes: () => [pane],
    focused: () => ({ terminal: pane.terminal, pane: pane.pane }),
    spaces: () => [{ id: "s1", name: "Project", tabs: [{ id: "tab1", name: "Review", named: true }] }],
    layout: () => ({ id: "sidebar", size: { px: 268 }, content: { mod: "spaces" } }), shared: () => null,
    theme: () => ({ selected: "#selected", muted: "#muted", foreground: "#foreground" }), setAgentOrder() {},
    div: element, v_flex: element, h_flex: element, svg: element, image: element,
  });
  // Names and icons come from the app's program table, as for tracked agents.
  agents.catalog = new Map([["claude", { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false }]]);
  agents.processes = parseProcesses("64 61 s010 claude\n61 1 s010 zsh");
  agents.tmuxPanes = parseTmuxPanes("900\t$0\t@1\t%4\t61\t0\tProject\t1\t0\tReview\t✻ Review\t99");
  agents.tmuxClients = parseTmuxClients("client\t55\t900\t$0\t%4\t@1");
  const find = (id: string) => {
    const walk = (node: any): any => node?.id === id ? node : node?.children?.map(walk).find(Boolean);
    return walk(agents.render({}).node);
  };
  expect(find("ag-t1").bg).toBe("#selected");
  expect(find("detected-agent-64").bg).toBeUndefined();
  const nameColor = (node: any): string | undefined => node?.children?.includes("Project")
    ? node.color : node?.children?.map(nameColor).find(Boolean);
  expect(nameColor(find("detected-agent-64"))).toBe("#muted");
  find("ag-t1").click();
  agents.hovered = "t1";
  find("pin-t1").click(null, { stop_propagation() {}, notify() {} });

  stock.focused = false;
  pane = { terminal: "tmux", pane: "p2", tab: "tab1" };
  expect(find("detected-agent-64").bg).toBe("#selected");
  const detectedRow = find("detected-agent-64");
  expect(nameColor(detectedRow)).toBe("#foreground");
  expect(nameColor(find("ag-t1"))).toBe("#muted");
  expect(textOf(find("ag-t1")).trim()).toStartWith("Project · Review");
  expect(textOf(detectedRow).trim()).toBe("Project · Review –");
  expect(detectedRow.tooltip).toBe("Claude Code · Project · Review · 1.0 · Status unavailable");
  find("detected-agent-64").click();
  agents.hovered = "detected-agent-64";
  find("pin-detected-agent-64").click(null, { stop_propagation() {}, notify() {} });
  expect(find("pinned")).toBeDefined();
  expect(JSON.parse(data.get("tmux.pins")!)).toHaveLength(1);
  expect(writes).toEqual([
    ["pane.focus", { pane: "p1" }], ["terminal.pin", { terminal: "t1", pinned: true }],
    ["spaces.open-tmux-agent-900-0-1-4"],
  ]);
});

test("the mod opens its own overlays by literal name, so mod.clone can rename them", () => {
  const targets = [...source.matchAll(/openOverlay\(\{ mod: ([^,]+),/g)].map(m => m[1]);
  expect(targets.length).toBeGreaterThan(0);
  expect(new Set(targets)).toEqual(new Set(['"agents"']));
});

test("repeated next-agent steps on while focus has not caught up with the last step", () => {
  const { agents, writes } = harness([]);
  const row = (address: string) => ({ address, navigate: () => writes.push(address) });
  agents.navigation = [row("a"), row("b"), row("c")];
  agents.followFocus("a", 0);
  agents.navigate("next-agent");
  const sent = agents.navigationPending.until;
  agents.followFocus("a", sent - 1);
  agents.navigate("next-agent");
  expect(writes).toEqual(["b", "c"]);
  agents.followFocus("c", sent);
  expect(agents.navigationPending).toBeNull();
  agents.navigate("next-agent");
  agents.followFocus("c", agents.navigationPending.until);
  expect(agents.navigationCurrent).toBe("c");
});

test("tmux and ps are polled only on Linux and macOS", () => {
  for (const [platform, polled] of [["windows", false], ["linux", true], ["macos", true]] as const) {
    const commands: string[] = [];
    harness([], {
      checking: () => false,
      window: () => ({ visible: true, platform }),
      exec: (command: string) => { commands.push(command); return new Promise(() => {}); },
      nextCommand: () => new Promise(() => {}),
      PS_ARGS: [], TMUX_PANE_ARGS: [],
    });
    expect(commands.length > 0).toBe(polled);
  }
});

test("a missing or failing tmux is asked again only after a pause, keeping the last panes", async () => {
  const calls: string[] = [];
  let reply: () => Promise<unknown> = () => Promise.reject(new Error("spawn tmux ENOENT"));
  const { agents } = harness([], {
    terminals: () => [], focused: () => null, panes: () => [], agents: () => [],
    exec: (command: string) => {
      calls.push(command);
      return command === "tmux" ? reply() : Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    PS_ARGS: [], TMUX_PANE_ARGS: [], parseProcesses, paneCommands, parseTmuxPanes, parseTmuxClients,
  });
  const discover = async () => {
    calls.length = 0;
    agents.nextProcessScan = 0;
    await new Promise<void>(done => agents.discover({ spawn: async (fn: any) => { await fn({ notify() {} }); done(); } }));
    return [...calls];
  };
  expect(await discover()).toEqual(["tmux", "ps"]);
  expect(await discover()).toEqual(["ps"]);
  agents.tmuxRetry = 0;
  reply = () => Promise.resolve({ code: 0, stdout: "900\t$0\t@1\t%4\t61\t0\tProject\t1\t0\tReview\t\t99\nclient\t55\t900\t$0\t%4\t@1", stderr: "" });
  await discover();
  expect([...agents.tmuxPanes.keys()]).toEqual([61]);
  reply = () => Promise.resolve({ code: 1, stdout: "", stderr: "server not responding" });
  await discover();
  expect([...agents.tmuxPanes.keys()]).toEqual([61]);
  expect(agents.tmuxClients.size).toBe(1);
  expect(await discover()).toEqual(["ps"]);
  agents.tmuxRetry = 0;
  reply = () => Promise.resolve({ code: 1, stdout: "", stderr: "no server running on /tmp/tmux-501/default" });
  await discover();
  expect(agents.tmuxPanes.size).toBe(0);
  expect(await discover()).toEqual(["tmux", "ps"]);
});

test("processes are read again only when a foreground program changes, or after 30 seconds", async () => {
  const calls: string[] = [];
  let panesOut = "900\t$0\t@1\t%4\t61\t0\tProject\t1\t0\tReview\t\t99\tzsh";
  const { agents } = harness([], {
    terminals: () => [], focused: () => null, panes: () => [], agents: () => [],
    exec: (command: string) => {
      calls.push(command);
      return Promise.resolve({ code: 0, stdout: command === "tmux" ? panesOut : "", stderr: "" });
    },
    PS_ARGS: [], TMUX_PANE_ARGS: [], parseProcesses, paneCommands, parseTmuxPanes, parseTmuxClients,
  });
  const discover = async () => {
    calls.length = 0;
    await new Promise<void>(done => agents.discover({ spawn: async (fn: any) => { await fn({ notify() {} }); done(); } }));
    return [...calls];
  };
  expect(await discover()).toEqual(["tmux", "ps"]);
  expect(await discover()).toEqual(["tmux"]);
  panesOut = panesOut.replace(/zsh$/, "claude");
  expect(await discover()).toEqual(["tmux", "ps"]);
  expect(await discover()).toEqual(["tmux"]);
  agents.nextProcessScan = 0;
  expect(await discover()).toEqual(["tmux", "ps"]);
});

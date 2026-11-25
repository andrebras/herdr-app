import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// Exercise the shipped view without a window or a core.
class Element {
  nodes: Element[] = [];
  calls: Record<string, any[]> = {};
  constructor() {
    const proxy: Element = new Proxy(this, {
      get: (target, key: string) => key in target ? (target as any)[key] : (...args: any[]) => {
        if (key === "child") target.nodes.push(args[0]);
        else if (key === "children") target.nodes.push(...args[0]);
        else if (key === "when") { if (args[0]) args[1](proxy); }
        else target.calls[key] = args;
        return proxy;
      },
    });
    return proxy;
  }
}
const source = await readFile(new URL("../defaults/mods/projects/main.js", import.meta.url), "utf8");
const element = () => new Element();
const commands: unknown[][] = [];
const execs: unknown[][] = [];
const state = { spaces: [] as any[], panes: [] as any[], config: null as string | null, found: "", dirs: new Set<string>() };
const values: Record<string, any> = {
  View: class {}, div: element, svg: element, v_flex: element, h_flex: element,
  Input: { new: element }, InputState: { new: () => ({ handlers: {} as Record<string, any>, on(name: string, handler: any) { this.handlers[name] = handler; }, focus() {} }) },
  spaces: () => state.spaces, panes: () => state.panes, theme: () => ({}), props: () => ({}), closeOverlay() {},
  run(...args: unknown[]) { commands.push(args); }, home: () => "/u", appHome: () => "/u/.config/herdr-app",
  readFile: async () => { if (state.config === null) throw new Error("missing"); return state.config; },
  exec: async (cmd: string, args: string[]) => {
    execs.push([cmd, ...args]);
    if (cmd === "find") return { code: 0, stdout: state.found };
    return { code: state.dirs.has(args[1]) ? 0 : 1, stdout: "" };
  },
};
const Projects = new Function(...Object.keys(values), source.replace(/^import .*;\n/gm, "").replace("export default class Projects", "return class Projects"))(...Object.values(values));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const tasks: Promise<unknown>[] = [];
const cx = { notify() {}, stop_propagation() {}, timer: { after() {} }, focus_handle() {}, spawn(f: any) { const p = f(cx); tasks.push(p); return p; } };

async function open(found: string[], spaces: any[] = [], config: string | null = null) {
  Object.assign(state, { spaces, panes: [], config, found: found.map((p) => `${p}/.git`).join("\n") + "\n" });
  commands.length = 0;
  execs.length = 0;
  const view = new Projects();
  view.init({}, cx);
  await Promise.all(tasks.splice(0));
  return view;
}
function type(view: any, text: string) {
  view.input.value = () => text;
  view.input.handlers.change({}, cx);
}
async function enter(view: any) {
  view.input.handlers.submit({}, cx);
  await Promise.all(tasks.splice(0));
  await settle();
}

test("lists repos under ~/Lab by default, without repos nested in another", async () => {
  const view = await open(["/u/Lab/onzehq", "/u/Lab/tempo", "/u/Lab/herdr-app", "/u/Lab/herdr-app/vendor/ghostty"]);
  expect(execs[0]).toEqual(["find", "/u/Lab", "-mindepth", "2", "-maxdepth", "4", "-name", ".git", "-prune"]);
  expect(view.rows().map((r: any) => r.name)).toEqual(["herdr-app", "onzehq", "tempo"]);
});

test("projects.json sets the roots, the depth and extra folders", async () => {
  const view = await open(["/u/code/api"], [], JSON.stringify({ roots: ["~/code"], depth: 2, folders: ["~/notes/"] }));
  expect(execs[0]).toEqual(["find", "/u/code", "-mindepth", "2", "-maxdepth", "3", "-name", ".git", "-prune"]);
  expect(view.rows().map((r: any) => r.path)).toEqual(["/u/code/api", "/u/notes"]);
});

test("open spaces come first, and a repo with a space shows once, as that space", async () => {
  const spaces = [
    { id: "s1", name: "tempo", folder: "/u/Lab/tempo", tabs: [] },
    { id: "s3", name: "notes", folder: "/u", tabs: [{ id: "t3", active: true }] },
    { id: "s2", name: "far", folder: "/srv", machine: "box", tabs: [] },
  ];
  const view = await open(["/u/Lab/onzehq", "/u/Lab/tempo"], spaces);
  state.panes = [{ tab: "t3", cwd: "/u/notes", focused: true }];
  expect(view.rows().map((r: any) => [r.kind, r.name, r.path])).toEqual([
    ["space", "tempo", "/u/Lab/tempo"],
    ["space", "notes", "/u/notes"],
    ["project", "onzehq", "/u/Lab/onzehq"],
  ]);
});

test("typing filters, best match first; Enter makes a space named after the folder", async () => {
  const view = await open(["/u/Lab/zonehq-old", "/u/Lab/onzehq", "/u/Lab/other"]);
  type(view, "onzehq");
  expect(view.rows().map((r: any) => r.name)).toEqual(["onzehq"]);
  type(view, "onz");
  expect(view.rows()[0].name).toBe("onzehq");
  await enter(view);
  expect(commands).toEqual([["space.new", { folder: "/u/Lab/onzehq", name: "onzehq" }]]);
});

test("a repo whose space has a terminal there goes to that space", async () => {
  const spaces = [{ id: "s1", name: "work", folder: "/u", tabs: [{ id: "t1" }] }];
  const view = await open(["/u/Lab/onzehq"], spaces);
  state.panes = [{ tab: "t1", cwd: "/u/Lab/onzehq/src" }];
  view.repos = ["/u/Lab/onzehq", "/u/Lab/new"];
  type(view, "new");
  await enter(view);
  expect(commands).toEqual([["space.new", { folder: "/u/Lab/new", name: "new" }]]);
  commands.length = 0;
  view.repos = ["/u/Lab/onzehq"];
  state.panes = [];
  state.spaces = [{ id: "s1", name: "work", folder: "/u", tabs: [{ id: "t1" }] }];
  state.panes = [{ tab: "t1", cwd: "/u/Lab/onzehq/src" }];
  await view.go({ kind: "project", name: "onzehq", path: "/u/Lab/onzehq" }, cx);
  expect(commands).toEqual([["space.select", { id: "s1" }]]);
});

test("no match: a typed folder opens, anything else does nothing", async () => {
  const view = await open(["/u/Lab/onzehq"]);
  state.dirs = new Set(["/u/code/foo"]);
  type(view, "nothing-like-it");
  await enter(view);
  expect(commands).toEqual([]);
  type(view, "~/code/missing");
  await enter(view);
  expect(commands).toEqual([]);
  expect(view.missing).toBe("~/code/missing");
  type(view, "~/code/foo/");
  await enter(view);
  expect(commands).toEqual([["space.new", { folder: "/u/code/foo", name: "foo" }]]);
});

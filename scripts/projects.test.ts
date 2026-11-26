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
// A fake disk: folder → its entries; a repo has a ".git" entry (a folder or a file).
const state = { spaces: [] as any[], panes: [] as any[], config: null as string | null, home: "/u", disk: new Map<string, string[]>(), reads: [] as string[] };
const parent = (p: string) => p.replace(/[/\\][^/\\]*$/, "");
function disk(paths: string[]) {
  state.disk = new Map();
  for (const path of paths) {
    let p = path;
    while (p.length > state.home.length) {
      const up = parent(p);
      const name = p.slice(up.length + 1);
      if (!state.disk.has(up)) state.disk.set(up, []);
      if (!state.disk.get(up)!.includes(name)) state.disk.get(up)!.push(name);
      if (!state.disk.has(p) && !name.startsWith(".git")) state.disk.set(p, []);
      p = up;
    }
  }
}
const values: Record<string, any> = {
  View: class {}, div: element, svg: element, v_flex: element, h_flex: element,
  Input: { new: element }, InputState: { new: () => ({ handlers: {} as Record<string, any>, on(name: string, handler: any) { this.handlers[name] = handler; }, focus() {} }) },
  spaces: () => state.spaces, panes: () => state.panes, theme: () => ({}), props: () => ({}), closeOverlay() {},
  run(...args: unknown[]) { commands.push(args); }, home: () => state.home, appHome: () => `${state.home}/.config/herdr-app`,
  readFile: async () => { if (state.config === null) throw new Error("missing"); return state.config; },
  readdir: async (dir: string, opts?: any) => {
    state.reads.push(dir);
    const names = state.disk.get(dir);
    if (!names) throw new Error("no such folder");
    return opts?.withFileTypes ? names.map((name) => ({ name, isDirectory: () => state.disk.has(`${dir}${dir.endsWith("/") || dir.endsWith("\\") ? "" : state.home.includes("\\") ? "\\" : "/"}${name}`) })) : names;
  },
  exists: async (path: string) => state.disk.get(parent(path))?.includes(path.slice(parent(path).length + 1)) ?? false,
};
const Projects = new Function(...Object.keys(values), source.replace(/^import .*;\n/gm, "").replace("export default class Projects", "return class Projects"))(...Object.values(values));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const tasks: Promise<unknown>[] = [];
const cx = { notify() {}, stop_propagation() {}, timer: { after() {} }, focus_handle() {}, spawn(f: any) { const p = f(cx); tasks.push(p); return p; } };

async function open(repos: string[], spaces: any[] = [], config: string | null = null, other: string[] = []) {
  Object.assign(state, { spaces, panes: [], config, reads: [] });
  disk([...repos.map((p) => `${p}/.git`), ...other]);
  commands.length = 0;
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

test("lists repos under ~/Lab by default, without repos nested in another or hidden ones", async () => {
  const view = await open(
    ["/u/Lab/shop", "/u/Lab/blog", "/u/Lab/herdr-app", "/u/Lab/herdr-app/vendor/ghostty", "/u/Lab/clients/acme/web", "/u/Lab/.cache/x", "/u/Lab/site/node_modules/pkg", "/u/Lab/a/b/c/too-deep"],
    [], null, ["/u/Lab/notes/readme"],
  );
  expect(view.rows().map((r: any) => r.name)).toEqual(["blog", "web", "herdr-app", "shop"]);
  expect(state.reads).not.toContain("/u/Lab/herdr-app");
  expect(state.reads).not.toContain("/u/Lab/a/b/c");
});

test("projects.json sets the roots, the depth and extra folders", async () => {
  const view = await open(["/u/code/api", "/u/code/x/y/deep", "/u/Lab/skipped"], [], JSON.stringify({ roots: ["~/code/"], depth: 2, folders: ["~/notes/"] }), ["/u/notes/todo"]);
  expect(view.rows().map((r: any) => r.path)).toEqual(["/u/code/api", "/u/notes"]);
});

test("open spaces come first, and a repo with a space shows once, as that space", async () => {
  const spaces = [
    { id: "s1", name: "blog", folder: "/u/Lab/blog", tabs: [] },
    { id: "s3", name: "notes", folder: "/u", tabs: [{ id: "t3", active: true }] },
    { id: "s2", name: "far", folder: "/srv", machine: "box", tabs: [] },
  ];
  const view = await open(["/u/Lab/shop", "/u/Lab/blog"], spaces);
  state.panes = [{ tab: "t3", cwd: "/u/notes", focused: true }];
  expect(view.rows().map((r: any) => [r.kind, r.name, r.path])).toEqual([
    ["space", "blog", "/u/Lab/blog"],
    ["space", "notes", "/u/notes"],
    ["project", "shop", "/u/Lab/shop"],
  ]);
});

test("typing filters, best match first; Enter makes a space named after the folder", async () => {
  const view = await open(["/u/Lab/washhouse-old", "/u/Lab/shop", "/u/Lab/other"]);
  type(view, "shop");
  expect(view.rows().map((r: any) => r.name)).toEqual(["shop"]);
  type(view, "sho");
  expect(view.rows()[0].name).toBe("shop");
  await enter(view);
  expect(commands).toEqual([["space.new", { folder: "/u/Lab/shop", name: "shop" }]]);
});

test("a repo whose space has a terminal there goes to that space", async () => {
  const spaces = [{ id: "s1", name: "work", folder: "/u", tabs: [{ id: "t1" }] }];
  const view = await open(["/u/Lab/shop"], spaces);
  state.panes = [{ tab: "t1", cwd: "/u/Lab/shop/src" }];
  view.repos = ["/u/Lab/shop", "/u/Lab/new"];
  type(view, "new");
  await enter(view);
  expect(commands).toEqual([["space.new", { folder: "/u/Lab/new", name: "new" }]]);
  commands.length = 0;
  view.repos = ["/u/Lab/shop"];
  state.panes = [];
  state.spaces = [{ id: "s1", name: "work", folder: "/u", tabs: [{ id: "t1" }] }];
  state.panes = [{ tab: "t1", cwd: "/u/Lab/shop/src" }];
  await view.go({ kind: "project", name: "shop", path: "/u/Lab/shop" }, cx);
  expect(commands).toEqual([["space.select", { id: "s1" }]]);
});

test("a typed path comes first, then what's inside it; a missing folder stays put", async () => {
  const view = await open(["/u/Lab/shop", "/u/Lab/blog"], [], null, ["/u/code/foo/file"]);
  type(view, "nothing-like-it");
  expect(view.rows()).toEqual([]);
  await enter(view);
  expect(commands).toEqual([]);
  type(view, "~/Lab");
  expect(view.rows().map((r: any) => [r.kind, r.name])).toEqual([["folder", "Lab"], ["project", "blog"], ["project", "shop"]]);
  type(view, "~/Lab/shop/");
  expect(view.rows().map((r: any) => r.kind)).toEqual(["project"]);
  type(view, "~/code/missing");
  await enter(view);
  expect(commands).toEqual([]);
  expect(view.missing).toBe("~/code/missing");
  type(view, "~/code/foo/");
  await enter(view);
  expect(commands).toEqual([["space.new", { folder: "/u/code/foo", name: "foo" }]]);
});

test("Windows paths: backslashes, a drive, ~\\ and names from either separator", async () => {
  state.home = "C:\\Users\\me";
  try {
    const view = await open([], [], JSON.stringify({ roots: ["~\\src"] }), ["C:\\Users\\me\\src\\api\\.git"]);
    expect(view.rows().map((r: any) => [r.name, r.path])).toEqual([["api", "C:\\Users\\me\\src\\api"]]);
    type(view, "~\\src\\");
    expect(view.rows().map((r: any) => r.kind)).toEqual(["folder", "project"]);
    await enter(view);
    expect(commands).toEqual([["space.new", { folder: "C:\\Users\\me\\src", name: "src" }]]);
    // A space with a terminal inside the repo is that repo's space, not a second one.
    commands.length = 0;
    state.spaces = [{ id: "s1", name: "work", folder: "C:\\Users\\me", tabs: [{ id: "t1", active: true }] }];
    state.panes = [{ tab: "t1", cwd: "C:\\Users\\me\\src\\api\\lib" }];
    expect(view.rows().map((r: any) => r.kind)).toEqual(["folder", "space"]);
    await view.go({ kind: "project", name: "api", path: "C:\\Users\\me\\src\\api" }, cx);
    expect(commands).toEqual([["space.select", { id: "s1" }]]);
  } finally {
    state.home = "/u";
  }
});

test("no projects at all says where to list folders", async () => {
  const view = await open([]);
  const text = JSON.stringify(view.render(), (k, v) => (k === "calls" ? undefined : v));
  expect(text).toContain("projects.json");
});

test("a typed folder outside home opens unchecked, since mods can't read there", async () => {
  const view = await open([]);
  type(view, "/opt/app");
  await enter(view);
  expect(commands).toEqual([["space.new", { folder: "/opt/app", name: "app" }]]);
});

test("listed folders that don't exist in home are left out", async () => {
  const view = await open([], [], JSON.stringify({ roots: [], folders: ["~/gone", "~/notes", "/srv/elsewhere"] }), ["/u/notes/readme"]);
  expect(view.rows().map((r: any) => r.path)).toEqual(["/u/notes", "/srv/elsewhere"]);
});

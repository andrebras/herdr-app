// Read the local user's process tree. Command arguments are used for matching
// CLI entrypoints and are never rendered or persisted.
// args comes last, so spaces inside it never shift the columns before it.
export const PS_ARGS = ["-xww", "-o", "pid=", "-o", "ppid=", "-o", "tty=", "-o", "args="];
export const TMUX_PANE_ARGS = ["-u", "-L", "default", "list-panes", "-a", "-F",
  "#{pid}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{window_name}\t#{pane_title}\t#{start_time}\t#{pane_current_command}",
  ";", "list-clients", "-F", "client\t#{client_pid}\t#{pid}\t#{session_id}\t#{pane_id}\t#{window_id}"];

// Executable names of agents, as their key in the app's program table (`knownAgents()`).
const KEYS = new Map([
  ["claude", "claude"], ["claude-code", "claude"],
  ["codex", "codex"], ["codex-aarch64-apple-darwin", "codex"], ["codex-x86_64-apple-darwin", "codex"],
  ["codex-aarch64-unknown-linux-musl", "codex"], ["codex-x86_64-unknown-linux-musl", "codex"],
  ["opencode", "opencode"], ["gemini", "gemini"], ["gemini-cli", "gemini"],
  ["aider", "aider"], ["amp", "amp"], ["cursor-agent", "cursor"],
  ["copilot", "copilot"], ["pi", "pi"],
]);
const base = path => path.split("/").at(-1);
const executable = path => KEYS.get(base(path).replace(/\.(?:c|m)?js$/, ""));

function identify(args) {
  const [program, entry, module] = args.split(/\s+/, 3);
  if (!program) return null;
  const name = executable(program);
  if (name) return name;
  if (/^(node|bun|deno|python(?:3(?:\.\d+)?)?)$/.test(base(program))) {
    if (entry === "-m") return executable(module ?? "");
    if (entry && !entry.startsWith("-")) return executable(entry) ?? null;
  }
  return null;
}

export function parseProcesses(stdout) {
  const processes = new Map();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const [, pid, parent, tty, args] = match;
    processes.set(Number(pid), { parent: Number(parent), name: identify(args), tty: /^\?+$/.test(tty) ? null : tty });
  }
  return processes;
}

// Each pane's shell and foreground program: when this changes, an agent may
// have started or stopped, so the process list is read again.
export function paneCommands(stdout) {
  return stdout.split("\n").filter(line => line && !line.startsWith("client\t"))
    .map(line => { const f = line.split("\t"); return f[4] + ":" + f.at(-1); }).sort().join(" ");
}

export function parseTmuxPanes(stdout) {
  const panes = new Map();
  for (const line of stdout.split("\n")) {
    const [server, session, window, pane, root, dead, label, windowIndex, paneIndex, windowName, paneTitle, start] = line.split("\t");
    if (!/^\d+$/.test(server) || !/^\$\d+$/.test(session) || !/^@\d+$/.test(window)
      || !/^%\d+$/.test(pane) || !/^\d+$/.test(root) || dead !== "0" || !label) continue;
    const pid = Number(root);
    const position = /^\d+$/.test(windowIndex) && /^\d+$/.test(paneIndex) ? windowIndex + "." + paneIndex : pane;
    const titles = [paneTitle, windowName].map(value => value?.replace(/[\x00-\x1f\x7f]/g, "").trim())
      .filter(value => value && !/^(?:v?\d+(?:\.\d+)+|claude(?: code)?|codex|zsh|bash|sh|[\w.-]+\.local)$/i.test(value));
    const value = { server, session, window, pane, label, start: /^\d+$/.test(start) ? start : null,
      titles, position };
    const matches = panes.get(pid) ?? [];
    matches.push(value);
    panes.set(pid, matches);
  }
  return panes;
}

export function parseTmuxClients(stdout) {
  const clients = new Map();
  for (const line of stdout.split("\n")) {
    const [kind, pid, server, session, pane, window] = line.split("\t");
    if (kind !== "client" || !/^\d+$/.test(pid) || !/^\d+$/.test(server) || !/^\$\d+$/.test(session)) continue;
    clients.set(Number(pid), {
      server, session, pane: /^%\d+$/.test(pane) ? pane : null, window: /^@\d+$/.test(window) ? window : null,
    });
  }
  return clients;
}

function* ancestors(processes, pid) {
  const seen = new Set([pid]);
  for (let parent = processes.get(pid)?.parent; parent > 0 && !seen.has(parent); parent = processes.get(parent)?.parent) {
    seen.add(parent);
    yield parent;
  }
}

export function focusedTmux(clients, terminals, address, processes) {
  if (!address || address.includes("/")) return null;
  const terminal = terminals.find(t => t.address === address);
  const direct = clients.get(terminal?.foreground?.pid) ?? clients.get(terminal?.pid);
  if (direct || !terminal || !processes) return direct ?? null;
  // Some shells and launch wrappers own the process group while tmux is a
  // child of that group. Only use a descendant if it identifies one client.
  const roots = new Set([terminal.foreground?.pid, terminal.pid]);
  const matches = [...clients].filter(([pid]) => {
    for (const parent of ancestors(processes, pid)) if (roots.has(parent)) return true;
    return false;
  });
  return matches.length === 1 ? matches[0][1] : null;
}

export function selectedDetectedAgent(agents, active, herdrPane) {
  if (!active) {
    return herdrPane ? agents.find(a => !a.tmux && a.pane === herdrPane)?.pid : undefined;
  }
  const session = agents.filter(a => a.tmux?.server === active.server && a.tmux.session === active.session);
  const pane = session.filter(a => a.tmux.pane === active.pane);
  if (pane.length) return pane.length === 1 ? pane[0].pid : undefined;
  // A tmux window may leave its shell or a work sidebar focused. In that
  // case select the agent only when the window or session identifies it.
  const window = session.filter(a => a.tmux.window === active.window);
  if (window.length) return window.length === 1 ? window[0].pid : undefined;
  return session.length === 1 ? session[0].pid : undefined;
}

export function detectedAgents(processes, tmuxPanes, terminals, herdrPanes, tracked, selected) {
  const existing = new Set(tracked.map(a => a.address));
  const shown = new Map(herdrPanes.filter(p => p.terminal).map(p => [p.terminal, p.pane]));
  const owned = new Map();
  for (const terminal of terminals) {
    if (!terminal.address || terminal.address.includes("/")) continue;
    const owner = {
      pane: shown.get(terminal.address), address: terminal.address, pinned: Boolean(terminal.labels?.["herdr.pinned"]),
      tracked: existing.has(terminal.address) || Boolean(terminal.status),
      name: processes.get(terminal.foreground?.pid)?.name ?? processes.get(terminal.pid)?.name,
    };
    if (terminal.pid) owned.set(terminal.pid, owner);
    if (terminal.foreground?.pid) owned.set(terminal.foreground.pid, owner);
  }

  const result = [];
  for (const [pid, process] of processes) {
    if (!process.name || !process.tty) continue;
    let tmux = tmuxPanes.get(pid), owner = owned.get(pid), nested = false;
    for (const parent of ancestors(processes, pid)) {
      tmux ??= tmuxPanes.get(parent);
      owner ??= owned.get(parent);
      if (processes.get(parent)?.name === process.name) { nested = true; break; }
    }
    const alreadyTracked = owner?.tracked && (owner.name === process.name || (!tmux && !owner.name));
    if (!nested && !alreadyTracked) {
      const target = tmux?.find(t => t.server === selected?.server && t.session === selected.session) ?? tmux?.[0];
      result.push({ pid, name: process.name, tmux: target, pane: owner?.pane, terminal: owner?.address, pinned: owner?.pinned, tty: process.tty });
    }
  }
  return result.sort((a, b) => Number(Boolean(b.tmux)) - Number(Boolean(a.tmux))
    || (a.tmux?.label ?? "").localeCompare(b.tmux?.label ?? "") || a.name.localeCompare(b.name) || a.pid - b.pid);
}

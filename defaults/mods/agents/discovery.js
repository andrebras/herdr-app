// Read the local user's process tree. Command arguments are used for matching
// CLI entrypoints and are never rendered or persisted.
export const psArgs = ["-xww", "-o", "pid=", "-o", "ppid=", "-o", "tty=", "-o", "comm=", "-o", "args="];
export const tmuxPaneArgs = ["-u", "-L", "default", "list-panes", "-a", "-F",
  "#{pid}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{window_name}",
  ";", "list-clients", "-F", "client\t#{client_pid}\t#{pid}\t#{session_id}\t#{pane_id}"];

const names = new Map([
  ["claude", "Claude Code"], ["claude-code", "Claude Code"],
  ["codex", "Codex"], ["codex-aarch64-apple-darwin", "Codex"], ["codex-x86_64-apple-darwin", "Codex"],
  ["codex-aarch64-unknown-linux-musl", "Codex"], ["codex-x86_64-unknown-linux-musl", "Codex"],
  ["opencode", "OpenCode"], ["gemini", "Gemini CLI"], ["gemini-cli", "Gemini CLI"],
  ["aider", "Aider"], ["amp", "Amp"], ["cursor-agent", "Cursor Agent"],
  ["copilot", "Copilot CLI"], ["pi", "Pi"],
]);
const base = path => path.split("/").at(-1);
const executable = path => names.get(base(path).replace(/\.(?:c|m)?js$/, ""));

function identify(command, args) {
  for (const name of names.keys()) {
    // macOS can give the full executable path in comm, including spaces.
    if (command === name || command.endsWith("/" + name)) return names.get(name);
  }
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
    const [, pid, parent, tty, rest] = match;
    // ps pads comm to a column; an overlong command gets at least one separator.
    const gap = /\s{2,}/.exec(rest) ?? /\s+/.exec(rest);
    const command = gap ? rest.slice(0, gap.index) : rest;
    const args = gap ? rest.slice(gap.index + gap[0].length) : command;
    processes.set(Number(pid), { parent: Number(parent), name: identify(command, args), tty: /^\?+$/.test(tty) ? null : tty });
  }
  return processes;
}

export function parseTmuxPanes(stdout) {
  const panes = new Map();
  for (const line of stdout.split("\n")) {
    const [server, session, window, pane, root, dead, label, windowIndex, paneIndex, ...title] = line.split("\t");
    if (!/^\d+$/.test(server) || !/^\$\d+$/.test(session) || !/^@\d+$/.test(window)
      || !/^%\d+$/.test(pane) || !/^\d+$/.test(root) || dead !== "0" || !label) continue;
    const pid = Number(root);
    const position = /^\d+$/.test(windowIndex) && /^\d+$/.test(paneIndex) ? windowIndex + "." + paneIndex : pane;
    const windowName = title.join(" ").replace(/[\x00-\x1f\x7f]/g, "").trim();
    const value = { server, session, window, pane, label, detail: windowName ? position + " · " + windowName : position };
    const matches = panes.get(pid) ?? [];
    matches.push(value);
    panes.set(pid, matches);
  }
  return panes;
}

export function parseTmuxClients(stdout) {
  const clients = new Map();
  for (const line of stdout.split("\n")) {
    const [kind, pid, server, session, pane] = line.split("\t");
    if (kind === "client" && /^\d+$/.test(pid) && /^\d+$/.test(server) && /^\$\d+$/.test(session) && /^%\d+$/.test(pane)) {
      clients.set(Number(pid), { server, session, pane });
    }
  }
  return clients;
}

export function focusedTmux(clients, terminals, address) {
  if (!address || address.includes("/")) return null;
  const terminal = terminals.find(t => t.address === address);
  return clients.get(terminal?.foreground?.pid) ?? clients.get(terminal?.pid) ?? null;
}

export function detectedAgents(processes, tmuxPanes, terminals, herdrPanes, tracked, selected) {
  const existing = new Set(tracked.map(a => a.address));
  const shown = new Map(herdrPanes.filter(p => p.terminal).map(p => [p.terminal, p.pane]));
  const owned = new Map();
  for (const terminal of terminals) {
    if (!terminal.address || terminal.address.includes("/")) continue;
    const owner = {
      pane: shown.get(terminal.address),
      tracked: existing.has(terminal.address) || Boolean(terminal.status),
      name: processes.get(terminal.foreground?.pid)?.name ?? processes.get(terminal.pid)?.name,
    };
    if (terminal.pid) owned.set(terminal.pid, owner);
    if (terminal.foreground?.pid) owned.set(terminal.foreground.pid, owner);
  }

  const result = [];
  for (const [pid, process] of processes) {
    if (!process.name) continue;
    let tmux = tmuxPanes.get(pid), owner = owned.get(pid), nested = false;
    const seen = new Set([pid]);
    for (let parent = process.parent; processes.has(parent) && !seen.has(parent); parent = processes.get(parent).parent) {
      seen.add(parent);
      tmux ??= tmuxPanes.get(parent);
      owner ??= owned.get(parent);
      if (processes.get(parent).name === process.name) { nested = true; break; }
    }
    if (!nested && (tmux || !owner?.tracked || (owner.name && owner.name !== process.name))) {
      const target = tmux?.find(t => t.server === selected?.server && t.session === selected.session) ?? tmux?.[0];
      result.push({ pid, name: process.name, tmux: target, pane: owner?.pane, tty: process.tty });
    }
  }
  return result.sort((a, b) => Number(Boolean(b.tmux)) - Number(Boolean(a.tmux))
    || (a.tmux?.label ?? "").localeCompare(b.tmux?.label ?? "") || a.name.localeCompare(b.name) || a.pid - b.pid);
}

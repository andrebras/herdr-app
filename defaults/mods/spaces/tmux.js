const marker = "herdr-tmux-client";
const sessionFormat = "session\t#{session_id}\t#{pid}\t#{socket_path}\t#{session_name}";
const clientFormat = "client\t#{client_pid}\t#{session_id}\t#{client_name}";

export const inspectArgs = [
  "-u", "-L", "default", "list-sessions", "-F", sessionFormat,
  ";", "list-clients", "-F", clientFormat,
];

export function parseSnapshot(stdout) {
  const sessions = [];
  const clients = [];
  for (const line of stdout.split("\n")) {
    const [kind, first, second, ...rest] = line.split("\t");
    if (kind === "session" && /^\$\d+$/.test(first) && /^\d+$/.test(second) && rest[0]?.startsWith("/") && rest.length > 1) {
      const [socket, ...name] = rest;
      sessions.push({ id: first, server: second, socket, name: name.join("\t") });
    } else if (kind === "client" && /^\d+$/.test(first) && /^\$\d+$/.test(second) && rest.length) {
      clients.push({ pid: Number(first), session: second, name: rest.join("\t") });
    }
  }
  return { sessions, clients };
}

export function findClients(clients, terminals, panes) {
  const byPid = new Map(clients.map(client => [client.pid, client]));
  const local = new Map(terminals.filter(t => t.address && !t.address.includes("/")).map(t => [t.address, t]));
  return panes.flatMap(pane => {
    const terminal = local.get(pane.terminal);
    const client = byPid.get(terminal?.foreground?.pid) ?? byPid.get(terminal?.pid);
    if (!client) return [];
    return [{ ...client, pane: pane.pane, address: terminal.address, tab: pane.tab, dedicated: terminal.argv?.includes(marker) }];
  });
}

export function attachArgv(binary, session) {
  // The core's shell may itself have been started from tmux.
  return ["/bin/sh", "-c", 'unset TMUX; exec "$@"', marker, binary, "-S", session.socket, "attach-session", "-E", "-t", session.id];
}

export function switchArgs(session, client) {
  return ["-S", session.socket, "switch-client", "-E", "-c", client.name, "-t", session.id];
}

export function newSessionArgs(folder, sessions) {
  const base = folder.split("/").filter(Boolean).pop()?.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "shell";
  const names = new Set(sessions.map(s => s.name));
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base}-${n}`;
  return ["-u", "-L", "default", "new-session", "-d", "-P", "-F", sessionFormat, "-c", folder, "-s", name];
}

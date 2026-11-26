const TERMINAL_SCRIPTS = {
  terminal: 'if application id "com.apple.Terminal" is not running then return "unavailable"\n' +
    'tell application id "com.apple.Terminal"\n' +
    'repeat with w in windows\nrepeat with t in tabs of w\n' +
    'if tty of t is targetTTY then\nset selected tab of w to t\nset index of w to 1\nactivate\nreturn "revealed"\nend if\n' +
    'end repeat\nend repeat\nend tell',
  iterm: 'if application id "com.googlecode.iterm2" is not running then return "unavailable"\n' +
    'tell application id "com.googlecode.iterm2"\n' +
    'repeat with w in windows\nrepeat with t in tabs of w\nrepeat with s in sessions of t\n' +
    'if tty of s is targetTTY then\nselect w\nselect t\nselect s\nreturn "revealed"\nend if\n' +
    'end repeat\nend repeat\nend repeat\nend tell',
};

export function macTerminalDevice(tty) {
  const name = tty?.replace(/^\/dev\//, "");
  if (/^ttys[0-9a-z]+$/.test(name)) return "/dev/" + name;
  if (/^s\d+$/.test(name)) return "/dev/tty" + name;
  return null;
}

export function revealTerminalArgs(app, tty) {
  const device = macTerminalDevice(tty);
  const script = TERMINAL_SCRIPTS[app];
  if (!device || typeof script !== "string") return null;
  return ["-e", 'on run argv\nset targetTTY to item 1 of argv\n' + script + '\nreturn "missing"\nend run', device];
}

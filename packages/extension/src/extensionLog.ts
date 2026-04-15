/**
 * Extension log forwarding — structured logger with WS sideband.
 *
 * Replaces the old `debugLog()` from relayConnection.ts. Each call:
 *   1. Writes to console (keeps DevTools working)
 *   2. Sends a `log:entry` message over the relay WS (if connected)
 *   3. Buffers when WS is unavailable (FIFO, capped at 100)
 *
 * Server-side, CDPRelay routes `log:*` messages to serverLog with
 * `ext:<channel>` prefix for grep-friendly filtering.
 */

export type LogChannel = 'debugger' | 'relay' | 'lifecycle' | 'registry' | 'tabManager' | 'downloads';
type LogLevel = 'info' | 'warn' | 'error';
export type LogEntry = { type: 'log:entry'; channel: string; level: string; message: string; ts: number; sessionId?: string };

const BUFFER_CAP = 100;
let _buffer: LogEntry[] = [];
let _send: ((entry: LogEntry) => boolean) | null = null;

export function setSink(send: (entry: LogEntry) => boolean): void {
  _send = send;
  flush();
}

export function clearSink(): void {
  _send = null;
}

function flush(): void {
  while (_buffer.length > 0 && _send) {
    const entry = _buffer[0];
    if (_send(entry))
      _buffer.shift();
    else
      break;
  }
}

function format(message: string, args: unknown[]): string {
  if (args.length === 0)
    return message;
  return message + ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
}

function emit(channel: LogChannel, level: LogLevel, consoleFn: (...args: unknown[]) => void, message: string, args: unknown[], sessionId?: string): void {
  const formatted = format(message, args);
  consoleFn(`[ext:${channel}]`, formatted);
  const entry: LogEntry = { type: 'log:entry', channel, level, message: formatted, ts: Date.now() };
  if (sessionId)
    entry.sessionId = sessionId;
  if (_send && _send(entry))
    return;
  _buffer.push(entry);
  if (_buffer.length > BUFFER_CAP)
    _buffer.shift();
}

export function extLog(channel: LogChannel, message: string, ...args: unknown[]): void {

  emit(channel, 'info', console.log, message, args);
}

export function extWarn(channel: LogChannel, message: string, ...args: unknown[]): void {

  emit(channel, 'warn', console.warn, message, args);
}

export function extError(channel: LogChannel, message: string, ...args: unknown[]): void {

  emit(channel, 'error', console.error, message, args);
}

/** Session-scoped variants — attach sessionId to log entries for server-side filtering. */
export function extLogS(channel: LogChannel, sessionId: string | undefined, message: string, ...args: unknown[]): void {

  emit(channel, 'info', console.log, message, args, sessionId);
}

export function extWarnS(channel: LogChannel, sessionId: string | undefined, message: string, ...args: unknown[]): void {

  emit(channel, 'warn', console.warn, message, args, sessionId);
}

export function extErrorS(channel: LogChannel, sessionId: string | undefined, message: string, ...args: unknown[]): void {

  emit(channel, 'error', console.error, message, args, sessionId);
}

// Test-only: reset internal state
export function _resetForTest(): void {
  _buffer = [];
  _send = null;
}

export function _getBuffer(): LogEntry[] {
  return _buffer;
}

/**
 * TEST INFRASTRUCTURE — not shipped runtime behavior.
 *
 * A tiny dependency-free TCP relay (`node:net`) that fronts a real HTTP upstream
 * and exposes per-connection failure controls modeling the four production
 * incidents behind the CLI's `/me/events` reliability stack. It parses no HTTP —
 * it is a pure byte pipe — so "which HTTP path a connection carries" is modeled
 * structurally by WHEN a connection was opened: {@link ChaosProxy.wedge} poisons
 * only connections that are ALREADY live, so a fresh dial opened afterwards (the
 * reconcile poll, an SSE reconnect) takes a healthy path — exactly as a real
 * tunnel edge black-holes an established socket while new connections route
 * elsewhere.
 *
 * Controls:
 *  - `wedge()`          — black-hole selected (default: all) LIVE connections in
 *                         BOTH directions without closing the sockets (ESTAB, zero
 *                         bytes, no FIN). Bytes are dropped, not buffered.
 *  - `stallNext()`      — the NEXT new connection establishes at TCP but forwards
 *                         nothing, so its HTTP response headers never arrive.
 *  - `holdDownstream()` — keep reading upstream→client bytes but BUFFER them on the
 *                         selected live connections; `release()` flushes the buffer
 *                         and resumes (the edge-buffers-then-bursts behavior).
 *  - `pinPath()`        — every NEW connection is wedged too (the path is dead)
 *                         until `heal()`; existing connections are untouched.
 *
 * Counters (`connectionsOpened`, per-connection `bytesUp`/`bytesDown` via
 * {@link ChaosProxy.stats}) let tests assert dialing behavior.
 */
import net from 'node:net';

/** Per-connection relay state. */
interface ProxyConn {
  id: number;
  client: net.Socket;
  upstream: net.Socket;
  upstreamReady: boolean;
  pendingUp: Buffer[];
  wedged: boolean;
  holdDown: boolean;
  heldDown: Buffer[];
  bytesUp: number;
  bytesDown: number;
  alive: boolean;
}

/** A connection selector; omitted = every currently-live connection. */
export type ConnFilter = (conn: { id: number; bytesUp: number; bytesDown: number }) => boolean;

/** A read-only snapshot of one relayed connection. */
export interface ConnStat {
  id: number;
  bytesUp: number;
  bytesDown: number;
  wedged: boolean;
  alive: boolean;
}

export class ChaosProxy {
  private readonly server: net.Server;
  private readonly conns = new Set<ProxyConn>();
  private seq = 0;
  private stallArmed = false;
  private pinned = false;
  private refusing = false;
  private readonly upstreamHost: string;
  private readonly upstreamPort: number;
  /** Total inbound client connections accepted since start (dialing counter). */
  connectionsOpened = 0;

  constructor(opts: { upstreamPort: number; upstreamHost?: string }) {
    this.upstreamHost = opts.upstreamHost ?? '127.0.0.1';
    this.upstreamPort = opts.upstreamPort;
    this.server = net.createServer((client) => this.accept(client));
    this.server.on('error', () => {});
  }

  /** Bind to an ephemeral port on loopback. */
  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
  }

  get port(): number {
    return (this.server.address() as net.AddressInfo).port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private accept(client: net.Socket): void {
    this.connectionsOpened += 1;
    // Path refuses NEW connects: reset the socket immediately (never dial
    // upstream). The client's fetch rejects with a non-abort connect error
    // (ECONNRESET/refused) — the same rejection CLASS as undici's own connect
    // timeout — exercising the reconnect/poll fresh-transport failure path.
    if (this.refusing) {
      client.on('error', () => {});
      client.destroy();
      return;
    }
    const conn: ProxyConn = {
      id: ++this.seq,
      client,
      upstream: net.connect(this.upstreamPort, this.upstreamHost),
      upstreamReady: false,
      pendingUp: [],
      // A connection born while the path is pinned (or while stallNext is armed)
      // is dead from the first byte: its request is never forwarded upstream, so
      // headers never come back.
      wedged: this.pinned || this.stallArmed,
      holdDown: false,
      heldDown: [],
      bytesUp: 0,
      bytesDown: 0,
      alive: true,
    };
    this.stallArmed = false;
    this.conns.add(conn);

    client.on('data', (d: Buffer) => {
      conn.bytesUp += d.length;
      if (conn.wedged) return; // black-hole: drop, never forward
      if (conn.upstreamReady) conn.upstream.write(d);
      else conn.pendingUp.push(d);
    });
    conn.upstream.on('connect', () => {
      conn.upstreamReady = true;
      if (!conn.wedged) for (const d of conn.pendingUp) conn.upstream.write(d);
      conn.pendingUp = [];
    });
    conn.upstream.on('data', (d: Buffer) => {
      conn.bytesDown += d.length;
      if (conn.wedged) return; // black-hole downstream too
      if (conn.holdDown) {
        conn.heldDown.push(d); // buffered until release()
        return;
      }
      client.write(d);
    });

    const teardown = (): void => this.destroy(conn);
    client.on('close', teardown);
    client.on('error', teardown);
    conn.upstream.on('close', teardown);
    conn.upstream.on('error', teardown);
  }

  private destroy(conn: ProxyConn): void {
    if (!conn.alive) return;
    conn.alive = false;
    this.conns.delete(conn);
    conn.client.destroy();
    conn.upstream.destroy();
  }

  private select(filter?: ConnFilter): ProxyConn[] {
    return [...this.conns].filter((c) => c.alive && (!filter || filter(c)));
  }

  /** Black-hole live connections in both directions (default: all live). */
  wedge(filter?: ConnFilter): void {
    for (const c of this.select(filter)) c.wedged = true;
  }

  /** Establish the NEXT new connection but forward nothing (headers never arrive). */
  stallNext(): void {
    this.stallArmed = true;
  }

  /** Buffer upstream→client bytes on live connections until {@link release}. */
  holdDownstream(filter?: ConnFilter): void {
    for (const c of this.select(filter)) c.holdDown = true;
  }

  /** Flush buffered downstream bytes and resume forwarding on live connections. */
  release(filter?: ConnFilter): void {
    for (const c of this.select(filter)) {
      c.holdDown = false;
      if (!c.wedged) for (const d of c.heldDown) c.client.write(d);
      c.heldDown = [];
    }
  }

  /** Wedge every NEW connection too (the path is dead) until {@link heal}. */
  pinPath(_mode: 'wedge' = 'wedge'): void {
    void _mode; // accepted for parity; a TCP relay stalls and black-holes alike
    this.pinned = true;
  }

  /**
   * Refuse every NEW connection: reset it at once (never reaching upstream), so
   * the client's fresh-transport fetch rejects with a connect error — the class
   * that surfaced the prod unhandled-rejection crash. Existing connections are
   * untouched. Clear via {@link heal}.
   */
  refuseNew(): void {
    this.refusing = true;
  }

  /** Stop pinning/refusing: connections opened after this forward normally again. */
  heal(): void {
    this.pinned = false;
    this.stallArmed = false;
    this.refusing = false;
  }

  /** Count of currently-live relayed connections. */
  liveConnections(): number {
    return this.select().length;
  }

  /** Per-connection snapshots (id, byte counts, wedged/alive) for assertions. */
  stats(): ConnStat[] {
    return [...this.conns].map((c) => ({
      id: c.id,
      bytesUp: c.bytesUp,
      bytesDown: c.bytesDown,
      wedged: c.wedged,
      alive: c.alive,
    }));
  }

  /** Destroy every connection and stop listening. */
  async close(): Promise<void> {
    for (const c of [...this.conns]) this.destroy(c);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

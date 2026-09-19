import type { ActionDefinition } from "@w6w/types";

interface Input {
  message: string;
  /**
   * When set, ALSO fetches this URL concurrently with the socket round
   * trip. Exists so one test can prove `ctx.fetch` and `ctx.socket.read()`
   * — issued in the same hook, in flight at once — each resolve with their
   * own reply off the shared request-id counter, never the other's.
   */
  fetchUrl?: string;
}

interface Output {
  /** Whether `ctx.socket` was present at all — direct proof of `enableSocket`'s effect. */
  socketPresent: boolean;
  echoed: string | null;
  fetched?: string;
}

/**
 * The positive twin of `raw-connect-attempt`: proves the exact same bytes
 * ARE reachable, but only by going *through* the host-mediated `ctx.socket`
 * — writes `input.message`, reads back whatever the host handed back, and
 * returns it verbatim. Reports `ctx.socket`'s mere presence rather than
 * throwing when it's absent, so the "disabled" case is an observable result
 * (`socketPresent: false`), not a swallowed error indistinguishable from a
 * real failure. This action never touches the network itself; in this node
 * the "socket" on the other end is whatever `onSocket` callback the test
 * supplies to `runHook` (a real one is T1.2.2's job) — the point is that the
 * proxy works before any real transport exists behind it.
 */
const proxiedEcho: ActionDefinition<Input, Output> = {
  key: "proxied-echo",
  type: "perform",
  title: "Proxied Echo",
  description: "Writes then reads a message through ctx.socket.",
  params: [
    { key: "message", label: "Message", type: "string", required: true },
    { key: "fetchUrl", label: "Fetch URL", type: "string" },
  ],
  output: [
    { key: "socketPresent", type: "boolean", label: "Socket present" },
    { key: "echoed", type: "string", label: "Echoed" },
    { key: "fetched", type: "string", label: "Fetched" },
  ],

  async execute(input, ctx) {
    if (!ctx.socket) return { socketPresent: false, echoed: null };
    const socket = ctx.socket;

    const writeAndRead = async () => {
      await socket.write(new TextEncoder().encode(input.message));
      return socket.read();
    };

    if (input.fetchUrl) {
      const [bytes, res] = await Promise.all([
        writeAndRead(),
        ctx.fetch(input.fetchUrl),
      ]);
      return {
        socketPresent: true,
        echoed: bytes ? new TextDecoder().decode(bytes) : null,
        fetched: await res.text(),
      };
    }

    const bytes = await writeAndRead();
    return {
      socketPresent: true,
      echoed: bytes ? new TextDecoder().decode(bytes) : null,
    };
  },
};

export default proxiedEcho;

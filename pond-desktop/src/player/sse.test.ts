import { describe, expect, it } from "vitest";
import { parseSse, type SseFrame } from "./sse";

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const f of parseSse(bodyOf(chunks))) out.push(f);
  return out;
}

describe("parseSse", () => {
  it("reads named events and their data", async () => {
    expect(
      await collect(['event: command\ndata: {"id":"1"}\n\n']),
    ).toEqual([{ event: "command", data: '{"id":"1"}' }]);
  });

  it("puts a frame split across chunks back together", async () => {
    expect(
      await collect(["event: comm", "and\ndata: {", '"a":1}\n', "\n"]),
    ).toEqual([{ event: "command", data: '{"a":1}' }]);
  });

  it("reads several frames from one chunk", async () => {
    const frames = await collect([
      "event: ready\ndata: {}\n\nevent: command\ndata: 1\n\n",
    ]);
    expect(frames.map((f) => f.event)).toEqual(["ready", "command"]);
  });

  it("drops keep-alive comments", async () => {
    expect(
      await collect([": keep-alive\n\nevent: ready\ndata: {}\n\n"]),
    ).toEqual([{ event: "ready", data: "{}" }]);
  });

  it("joins multi-line data with newlines", async () => {
    expect(await collect(["data: a\ndata: b\n\n"])).toEqual([
      { event: "message", data: "a\nb" },
    ]);
  });

  it("accepts CRLF line endings, even split between chunks", async () => {
    expect(await collect(["event: ready\r", "\ndata: {}\r\n\r\n"])).toEqual([
      { event: "ready", data: "{}" },
    ]);
  });

  it("does not yield a frame the stream cut off", async () => {
    expect(await collect(["event: command\ndata: {"])).toEqual([]);
  });

  it("stops when aborted, even while waiting for the next chunk", async () => {
    const controller = new AbortController();
    const idle = new ReadableStream<Uint8Array>({ start() {} });
    const seen: SseFrame[] = [];
    const reading = (async () => {
      for await (const f of parseSse(idle, controller.signal)) seen.push(f);
    })();
    controller.abort();
    await reading;
    expect(seen).toEqual([]);
  });
});

// Server-sent events off a fetch body. EventSource cannot send the Authorization header this
// server requires, and the chat reader in PondApiClient ignores event names and gives up after
// two minutes, which a command stream that stays open for days cannot live with.

export interface SseFrame {
  event: string;
  data: string;
}

function parseFrame(text: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  let seen = false;
  for (const line of text.split("\n")) {
    // A colon opens a comment: the server's keep-alive.
    if (line === "" || line.startsWith(":")) continue;
    const at = line.indexOf(":");
    const field = at === -1 ? line : line.slice(0, at);
    let value = at === -1 ? "" : line.slice(at + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      event = value;
      seen = true;
    } else if (field === "data") {
      data.push(value);
      seen = true;
    }
  }
  return seen ? { event, data: data.join("\n") } : null;
}

/** Yields each frame as it completes; ends when the body ends or `signal` aborts. */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", cancel, { once: true });
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // Normalised over the whole buffer, so a CR and its LF may arrive in different chunks.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(
        /\r\n/g,
        "\n",
      );
      for (
        let end = buffer.indexOf("\n\n");
        end !== -1;
        end = buffer.indexOf("\n\n")
      ) {
        const frame = parseFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (frame) yield frame;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
  }
}

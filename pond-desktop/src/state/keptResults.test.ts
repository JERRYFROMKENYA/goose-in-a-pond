import { describe, it, expect } from "vitest";
import { keptLine, keptResultOf } from "./keptResults";
import { SEARCH_STUB, SEARCH_TOOL, assistantRow, keptToolRow, userRow } from "../test-support/keptRows";

describe("keptResultOf", () => {
  it("reads the stub from a stored row marked transient", () => {
    expect(keptResultOf(keptToolRow())).toEqual({
      callId: "call-1",
      tool: SEARCH_TOOL,
      stub: SEARCH_STUB,
    });
  });

  it("leaves a result the pond kept whole to the history it has always had", () => {
    const whole = keptToolRow({}, { transient: undefined, content: "Weather: 24 degrees." });
    expect(keptResultOf(whole)).toBeNull();
    expect(keptResultOf(keptToolRow({}, { transient: false }))).toBeNull();
  });

  it("is not fooled by a row that only says it is not transient in words", () => {
    expect(keptResultOf(keptToolRow({}, { transient: "true" }))).toBeNull();
  });

  it("reads only tool rows", () => {
    expect(keptResultOf(assistantRow())).toBeNull();
    expect(keptResultOf(userRow({ transient: true }))).toBeNull();
  });

  it("takes the stub as it is when the marker comes on the message with no row around it", () => {
    const flat = keptToolRow({ content: SEARCH_STUB, transient: true });
    expect(keptResultOf(flat)).toEqual({ callId: "call-1", tool: "", stub: SEARCH_STUB });
  });

  it("says nothing for a row with no stub to show", () => {
    expect(keptResultOf(keptToolRow({}, { content: "   " }))).toBeNull();
    expect(keptResultOf(keptToolRow({ content: "not json" }))).toBeNull();
  });
});

describe("keptLine", () => {
  const kept = { callId: "c", tool: SEARCH_TOOL, stub: SEARCH_STUB };

  it("says the results are not kept, and which sources they came from", () => {
    expect(keptLine(kept)).toBe(
      "Web search: results aren't kept after the turn. Sources: kenyapower.co.ke, nation.africa.",
    );
  });

  it("says no more than it knows when the stub names no sources", () => {
    expect(keptLine({ ...kept, stub: "Web search results are not kept after the turn." })).toBe(
      "Web search: results aren't kept after the turn.",
    );
  });

  it("names a tool it has no friendly name for in words, and an unknown one as a tool", () => {
    expect(keptLine({ ...kept, tool: "giap-x__look_up_thing" })).toMatch(/^Look Up Thing: /);
    expect(keptLine({ ...kept, tool: "" })).toMatch(/^Tool: /);
  });

  it("never lets a long stub run on", () => {
    const line = keptLine({ ...kept, stub: `Sources: ${"a.example, ".repeat(100)}` });
    expect(line.length).toBeLessThan(300);
  });
});

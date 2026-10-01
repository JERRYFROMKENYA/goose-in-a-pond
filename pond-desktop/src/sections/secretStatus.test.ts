import { describe, expect, it } from "vitest";
import { secretStatusOf } from "./secretStatus";
import type { SecretRequirement } from "../api/types";

const req = (key: string, required: boolean): SecretRequirement => ({
  key,
  display_name: key,
  description: "",
  required,
  kind: "api_key",
});

describe("secretStatusOf", () => {
  it("is optional when nothing is required, whatever is or is not filled in", () => {
    const requirements = [req("A", false), req("B", false)];
    expect(secretStatusOf({ requirements, fulfilled: { A: false, B: false } })).toBe("optional");
    expect(secretStatusOf({ requirements, fulfilled: { A: true, B: false } })).toBe("optional");
  });

  it("needs setup while a required secret is missing", () => {
    const requirements = [req("TOKEN", true), req("EXTRA", false)];
    expect(secretStatusOf({ requirements, fulfilled: { TOKEN: false, EXTRA: true } })).toBe("missing");
  });

  it("is configured once every required secret is there, optional ones aside", () => {
    const requirements = [req("TOKEN", true), req("EXTRA", false)];
    expect(secretStatusOf({ requirements, fulfilled: { TOKEN: true, EXTRA: false } })).toBe("configured");
  });

  it("treats a required secret the server did not report as missing", () => {
    expect(secretStatusOf({ requirements: [req("TOKEN", true)], fulfilled: {} })).toBe("missing");
  });

  it("is optional for an extension with no secrets at all", () => {
    expect(secretStatusOf({ requirements: [], fulfilled: {} })).toBe("optional");
  });
});

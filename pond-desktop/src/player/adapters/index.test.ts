import { describe, expect, it } from "vitest";
import { createAdapter, knownServices, type AdapterContext } from "./index";

const ctx: AdapterContext = {
  fetchDeveloperToken: async () => "developer-token",
  networkAllows: async () => null,
  fetchUserToken: async () => "user-token",
};

describe("the adapter registry", () => {
  it("knows the two services, in order", () => {
    expect(knownServices()).toEqual(["apple", "spotify"]);
  });

  it("makes an adapter for a service it knows", () => {
    expect(createAdapter("apple", ctx)).not.toBeNull();
    expect(createAdapter("spotify", ctx)).not.toBeNull();
  });

  // `?service=` is the page's URL: a name only an object's prototype answers must get nothing.
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "tidal", ""])(
    "makes nothing for %j",
    (service) => {
      expect(createAdapter(service, ctx)).toBeNull();
    },
  );
});

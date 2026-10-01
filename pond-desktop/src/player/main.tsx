// The music player page. It runs in the person's own browser, served by the pond at /player.html,
// because that is where the services document their players: an ordinary web page in a mainstream
// browser, visible, and started with a click. It pairs with the pond as its own device (over
// loopback, so the page has to be opened on the pond's own computer), runs each service it is asked
// for, and relays the pond's commands to them.

import React from "react";
import ReactDOM from "react-dom/client";

import "../styles/design-tokens.css";
import "../styles/base.css";

import { PondApiClient } from "../api/PondApiClient";
import { createAdapter, knownServices } from "./adapters";
import { PlayerBridge } from "./bridge";
import { Players } from "./Players";
import { retrySetup } from "./retry";

// `?service=apple,spotify` narrows the page to those services; none means every one it has.
const asked = (new URLSearchParams(window.location.search).get("service") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const services = asked.length > 0 ? asked : knownServices();
const api = new PondApiClient();
api.setDeviceName("GIAP Music Player");

const context = {
  fetchDeveloperToken: async () => (await api.musickitDeveloperToken()).token,
  networkAllows: (url: string) => api.playerNetworkAllows(url),
  fetchUserToken: async (service: string, refresh: boolean) =>
    (await api.playerUserToken(service, refresh)).token,
};
const adapters = services.flatMap((s) => {
  const adapter = createAdapter(s, context);
  return adapter ? [adapter] : [];
});

const root = ReactDOM.createRoot(document.getElementById("root")!);

if (adapters.length === 0) {
  root.render(
    <main className="player">
      <p className="player__text">
        There is no player for "{services.join(", ")}". Available: {knownServices().join(", ")}.
      </p>
    </main>,
  );
} else {
  root.render(
    <React.StrictMode>
      <Players adapters={adapters} />
    </React.StrictMode>,
  );

  void (async () => {
    // Pair first, so the bridge's first request already carries a session.
    await api.connect().catch(() => null);
    await Promise.all(adapters.map((adapter) => adapter.init()));
    for (const adapter of adapters) {
      // A key added after this page opened is picked up without a reload.
      retrySetup(adapter);
      new PlayerBridge(adapter, api, {
        log: (message, detail) =>
          console.warn(`[player:${adapter.service}] ${message}`, detail ?? ""),
      }).start();
    }
  })();
}

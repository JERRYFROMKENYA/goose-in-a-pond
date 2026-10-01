// Hub Home: the screen is `DashboardGrid` (shared with `sections/Dashboard.tsx`);
// only routing and the way into voice mode are per-surface.

import { useAppState, useAppDispatch } from "../../state/AppContext";
import type { GuiSection } from "../../desktopState";
import { DashboardGrid } from "./DashboardGrid";
import { sendTurn } from "../../state/chatRunStore";

interface HomeViewProps {
  /** Takes a GuiSection, not a hub route; the shell translates (see `Hub`'s `navigate`). */
  go?: (section: GuiSection) => void;
}

export function HomeView({ go }: HomeViewProps) {
  const state = useAppState();
  const dispatch = useAppDispatch();

  return (
    <DashboardGrid
      sessionId={state.sessionId}
      onNavigate={(section) =>
        go ? go(section) : dispatch({ type: "SET_SECTION", payload: section })
      }
      onTalk={() => dispatch({ type: "SET_MODE", payload: "voice" })}
      // Send first, then navigate, as in `sections/Dashboard.tsx` (which says why).
      onAsk={(prompt) => {
        sendTurn({ text: prompt });
        if (go) go("chat");
        else dispatch({ type: "SET_SECTION", payload: "chat" });
      }}
    />
  );
}

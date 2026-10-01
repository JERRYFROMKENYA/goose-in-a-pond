// Hamburger and bell only: the design header's clock, weather and avatar belong to Home.

import { HubIco } from "./primitives/HubIco";
import { HP_PATHS } from "./primitives/icons";
import "./hubDrawer.css";

export interface ShellBarProps {
  onMenu: () => void;
  onBell: () => void;
  /** Unread schedule runs. */
  unread: number;
}

export function ShellBar({ onMenu, onBell, unread }: ShellBarProps) {
  return (
    <div className="shellbar">
      <button
        type="button"
        className="shellbar__btn"
        onClick={onMenu}
        aria-label="Open menu"
      >
        <i className="shellbar__bar" />
        <i className="shellbar__bar" />
        <i className="shellbar__bar" />
      </button>
      <button
        type="button"
        className="shellbar__btn"
        onClick={onBell}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
      >
        <HubIco d={HP_PATHS.bell} size={20} color="var(--color-text)" sw={1.9} />
        {unread > 0 && (
          <span className="shellbar__count" aria-hidden="true">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
    </div>
  );
}

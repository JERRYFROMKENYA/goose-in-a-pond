// The sign that the composer is in research mode, with the way out. Sits above the field.

import { Telescope, X } from "lucide-react";
import { DEEP_RESEARCH, LEAVE_RESEARCH, RESEARCH_WAITS } from "./deepResearchCopy";
import "./composerMenu.css";

interface Props {
  variant: "classic" | "hub";
  /** A reply is still streaming, so Send is held until it ends. */
  waiting: boolean;
  onLeave: () => void;
}

export function ResearchModeChip({ variant, waiting, onLeave }: Props) {
  return (
    <div
      className={`rchip-row rchip-row--${variant}`}
      // Escape on the chip's own button is as good as the field's.
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onLeave();
        }
      }}
    >
      <span className="rchip">
        <Telescope size={14} aria-hidden="true" />
        <span className="rchip__label">{DEEP_RESEARCH}</span>
        <button type="button" className="rchip__x" aria-label={LEAVE_RESEARCH} title={LEAVE_RESEARCH} onClick={onLeave}>
          <X size={14} aria-hidden="true" />
        </button>
      </span>
      {waiting && (
        <span className="rchip__wait" role="status">
          {RESEARCH_WAITS}
        </span>
      )}
    </div>
  );
}

// Picture-support strip for the active chat model, above the AttachmentTray (attaching still
// works). In-progress states always show; permanent ones only when `revealed`.

import { Image, ImageOff, Loader2 } from "lucide-react";
import type { VisionStatus } from "../api/types";
import "../styles/vision-status.css";

const PERSISTENT_KINDS = new Set(["absent", "downloading", "verifying", "failed", "blocked"]);
const SPINNING_KINDS = new Set(["downloading", "verifying"]);
const MUTED_KINDS = new Set(["failed", "blocked"]);

/** Copy for `not_declared`, which has no server prose; pinned to design_v2.md §B1. */
export const NOT_DECLARED_COPY =
  "This model cannot look at pictures. To send one, choose a model marked Reads pictures on the Models page.";

/** Under-composer line when a send waits on picture support; shared so both shells agree. */
export const COMPOSER_GATE_LINE =
  "Pictures can be sent once picture support is ready. Remove them to send just the text.";

/** Clause for a restored 409's message (design_v2.md §H); unknown codes get the fallback. */
export function refusalClientClause(code: string | undefined): string {
  if (code === "vision_not_ready") {
    return " Your message and pictures are back in the box; send them when it is ready.";
  }
  if (code === "vision_unsupported") {
    return " Your message and pictures are back in the box. Remove the pictures to send just the text.";
  }
  return " Your message and pictures are back in the box.";
}

/** "HH:MM", 24-hour, from a retry timestamp — what `failed`'s copy appends. */
function formatRetryClock(unixMs: number): string {
  const d = new Date(unixMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

interface ImageSupportStatusProps {
  status: VisionStatus | null;
  /** They just reached for the paperclip or pasted: only then do permanent reasons show. */
  revealed: boolean;
}

export function ImageSupportStatus({ status, revealed }: ImageSupportStatusProps) {
  const kind = status?.state.kind;
  if (!status || !kind || kind === "ready" || kind === "unknown") return null;
  if (!PERSISTENT_KINDS.has(kind) && !revealed) return null;

  let line = status.message ?? (kind === "not_declared" ? NOT_DECLARED_COPY : "");
  if (kind === "failed" && status.state.kind === "failed") {
    line = `${line} It tries again at ${formatRetryClock(status.state.retry_at_unix_ms)}.`;
  }
  if (!line) return null;

  const Icon = SPINNING_KINDS.has(kind) ? Loader2 : MUTED_KINDS.has(kind) ? ImageOff : Image;

  return (
    <div className="vision-status" role="status" aria-live="polite">
      <Icon
        size={14}
        className={SPINNING_KINDS.has(kind) ? "vision-status__spin" : undefined}
        aria-hidden
      />
      <span>{line}</span>
    </div>
  );
}

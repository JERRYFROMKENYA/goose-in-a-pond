import { useEffect, useState } from "react";
import { api } from "../api/PondApiClient";

/** Fallback chips about the assistant, never the house: every pond can answer these. */
const ABOUT_THE_ASSISTANT = [
  "What can you help me with?",
  "What do you remember about me?",
  "What can you see in this house?",
];

/** The composer's chips, from the suggestion engine. `sessionId` is optional; one narrows the audience. */
export function useSuggestedPrompts(sessionId?: string | null): string[] {
  const [prompts, setPrompts] = useState<string[]>(ABOUT_THE_ASSISTANT);

  useEffect(() => {
    let cancelled = false;

    // Reset now, not when the fetch lands: chips can be personal, and the next person may be a guest.
    setPrompts(ABOUT_THE_ASSISTANT);

    async function load(): Promise<void> {
      try {
        const list = await api.listSuggestions(sessionId ?? null);
        if (cancelled) return;
        const offered = (list.suggestions ?? []).map((s) => s.prompt);
        // Empty keeps the fallback: a chipless composer reads as a load that never finishes.
        if (offered.length > 0) setPrompts(offered);
      } catch {
        // The fallback stays; a convenience shouldn't render an error.
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return prompts;
}

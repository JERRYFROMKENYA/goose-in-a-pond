import type { SecretRequirement } from "../api/types";

/** What the card's badge says about an extension's credentials. */
export type SecretStatus = "configured" | "missing" | "optional" | "unknown";

/**
 * Only a secret marked `required` can make an extension need setup. Every secret optional means
 * it works as it is, so the card must not say "Setup required" over an extension that has nothing
 * to set up; the key icon still opens the fields for someone who wants them.
 */
export function secretStatusOf(res: {
  requirements: SecretRequirement[];
  fulfilled: Record<string, boolean>;
}): SecretStatus {
  const required = res.requirements.filter((r) => r.required);
  if (required.length === 0) return "optional";
  return required.every((r) => res.fulfilled[r.key] === true)
    ? "configured"
    : "missing";
}

// `bare`: DetailShell already draws the heading and subtitle.

import { DetailShell } from "./DetailShell";
import { BackgroundJobs } from "../../../settings/BackgroundJobs";

export function BackgroundJobsDetail({ go }: { go: (route: string) => void }) {
  return (
    <DetailShell
      title="Background jobs"
      subtitle="What the pond does while nobody is talking to it"
      onBack={() => go("settings")}
    >
      <BackgroundJobs bare />
    </DetailShell>
  );
}

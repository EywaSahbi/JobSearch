import { readApplications, readInbox, doctorState } from "@/lib/career-ops";
import { todaySnapshot } from "@/lib/home/today-snapshot.mjs";
import { scoreNum } from "@/lib/format";
import { OnboardingBanner } from "@/components/onboarding-banner";
import { FirstRunHome } from "@/components/home/first-run-home";
import { TodayDashboard } from "@/components/home/today-dashboard";

export const dynamic = "force-dynamic";

export default function Home() {
  const snapshot = { applications: readApplications(), inbox: readInbox() };
  const { phase, onboardingNeeded } = doctorState(snapshot);
  if (phase === "first-run") return <FirstRunHome />;

  const { inbox, applications } = todaySnapshot(snapshot, scoreNum);
  return (
    <>
      {onboardingNeeded && <OnboardingBanner />}
      <TodayDashboard applications={applications} inbox={inbox} inBetween={phase === "in-between"} />
    </>
  );
}

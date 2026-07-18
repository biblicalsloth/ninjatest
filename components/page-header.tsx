import { NinjatestLogo } from "@/components/ninja-logo";

/*
 * Shared screen header: brand lockup top-left, then the screen label in the
 * Study-plan treatment (font-pixel title + muted sub). mt-6 between logo and
 * label matches the lobby's logo→greeting gap. Server-safe (no hooks) so
 * ISR pages (leaderboard) can render it without going dynamic.
 */
export function PageHeader({
  label,
  sub,
  right,
}: {
  label: string;
  sub?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <header>
      <NinjatestLogo />
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="mr-auto min-w-0">
          <h1 className="font-pixel text-xl text-white">{label}</h1>
          {sub && <p className="text-xs text-[#7ab5cc] mt-1">{sub}</p>}
        </div>
        {right}
      </div>
    </header>
  );
}

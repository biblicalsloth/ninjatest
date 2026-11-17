/*
 * Shared screen header: the screen label in the Study-plan treatment
 * (font-pixel title + muted sub). The brand lockup lives in the SideNav now,
 * so it isn't repeated here. Server-safe (no hooks) so ISR pages
 * (leaderboard) can render it without going dynamic.
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
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto min-w-0">
          <h1 className="font-pixel text-xl text-white">{label}</h1>
          {sub && <p className="text-xs text-[#7ab5cc] mt-1">{sub}</p>}
        </div>
        {right}
      </div>
    </header>
  );
}

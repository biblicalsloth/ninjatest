// A question's diagram (bar/pie/line charts, tables-as-images) served via image_url.
// Crops vary wildly in size (127px wide up to 807px-tall 4-figure composites), so
// the raw <img> could either render unreadably small or shove the options below the
// fold during a timed match. This bounds it: capped display width for consistent
// scale, capped height with scroll so a tall composite never dominates the card, and
// max-w-full so nothing ever overflows the card horizontally on mobile.
export function QuestionDiagram({ url }: { url: string }) {
  return (
    <div className="flex max-h-[55vh] justify-center overflow-auto rounded-xl border border-[#222222] bg-black/20 p-1">
      <img
        src={url}
        alt="Question diagram"
        loading="lazy"
        className="h-auto w-full max-w-[440px] rounded-lg"
      />
    </div>
  );
}

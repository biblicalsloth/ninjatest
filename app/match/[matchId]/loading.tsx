import { Loader2 } from "lucide-react";

export default function MatchLoading() {
  return (
    <div className="min-h-screen bg-[#001e2b] flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="text-[#00ed64] animate-spin" size={28} />
        <p className="text-[#5c6c7a] text-sm">Loading match…</p>
      </div>
    </div>
  );
}

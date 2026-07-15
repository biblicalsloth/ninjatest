import { Loader2 } from "lucide-react";

// Lightweight route Suspense fallback. Non-fixed + transparent so the
// persistent SideNav (fixed, in the root layout) stays visible on top and
// screen switches don't flash — only the page content swaps.
export function PageLoading() {
  return (
    <div className="min-h-screen bg-[#120F17] flex items-center justify-center">
      <Loader2 className="text-[#06d6a0] animate-spin" size={24} />
    </div>
  );
}

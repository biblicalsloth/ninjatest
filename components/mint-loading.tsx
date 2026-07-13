import { NinjaLogo } from "@/components/ninja-logo";

// Mirrors the mint auth panel (components/auth-panel.tsx). Used as the
// Suspense fallback in route loading.tsx files — Next swaps it out the
// moment the page resolves, so the bar never lingers past load.
export function MintLoading({ message }: { message: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#06d6a0] px-6">
      <style>{`
        @keyframes mint-fill {
          0% { width: 0%; }
          50% { width: 62%; }
          100% { width: 92%; }
        }
      `}</style>
      <div className="w-full max-w-sm text-center">
        <div className="inline-flex items-center gap-2 mb-2">
          <div className="w-8 h-8 rounded-full bg-[#120F17] flex items-center justify-center overflow-hidden">
            <NinjaLogo color="#06d6a0" className="w-5 h-5" />
          </div>
          <span className="text-[#120F17] font-bold text-xl tracking-tight">Ninjatest</span>
        </div>
        <p className="text-[#120F17]/60 text-sm mb-8">{message}</p>
        <div className="h-2 rounded-full bg-[#120F17]/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-[#120F17]"
            style={{ animation: "mint-fill 2.4s cubic-bezier(0.2, 0.8, 0.3, 1) forwards" }}
          />
        </div>
      </div>
    </div>
  );
}

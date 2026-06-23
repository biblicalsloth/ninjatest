export default function LobbyLoading() {
  return (
    <div className="min-h-screen bg-[#001e2b] animate-pulse">
      <header className="border-b border-[#1c2d38] px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-[#1c2d38]" />
            <div className="w-24 h-4 rounded bg-[#1c2d38]" />
          </div>
          <div className="w-8 h-8 rounded-full bg-[#1c2d38]" />
        </div>
      </header>
      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <div className="bg-[#1c2d38] rounded-xl p-5 flex items-center gap-4">
          <div className="w-14 h-14 rounded-full bg-[#003d4f]" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-32 rounded bg-[#003d4f]" />
            <div className="h-3 w-20 rounded bg-[#003d4f]" />
          </div>
          <div className="w-16 h-8 rounded bg-[#003d4f]" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-[#1c2d38] rounded-xl p-4 text-center space-y-1">
              <div className="h-6 w-12 rounded bg-[#003d4f] mx-auto" />
              <div className="h-3 w-16 rounded bg-[#003d4f] mx-auto" />
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <div className="h-14 rounded-full bg-[#1c2d38]" />
          <div className="h-12 rounded-full bg-[#1c2d38]" />
        </div>
      </main>
    </div>
  );
}

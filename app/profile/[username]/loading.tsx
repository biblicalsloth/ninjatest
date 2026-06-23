export default function ProfileLoading() {
  return (
    <div className="min-h-screen bg-[#001e2b] animate-pulse">
      <header className="border-b border-[#1c2d38] px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="w-12 h-4 rounded bg-[#1c2d38]" />
          <div className="w-16 h-4 rounded bg-[#1c2d38]" />
        </div>
      </header>
      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center gap-4">
          <div className="w-20 h-20 rounded-full bg-[#1c2d38]" />
          <div className="flex-1 space-y-2">
            <div className="h-5 w-40 rounded bg-[#1c2d38]" />
            <div className="h-3 w-24 rounded bg-[#1c2d38]" />
            <div className="h-6 w-20 rounded bg-[#1c2d38]" />
          </div>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-[#1c2d38] rounded-xl p-3 space-y-1">
              <div className="h-5 w-10 rounded bg-[#003d4f] mx-auto" />
              <div className="h-3 w-12 rounded bg-[#003d4f] mx-auto" />
            </div>
          ))}
        </div>
        <div className="bg-[#1c2d38] rounded-xl p-5 h-48" />
      </main>
    </div>
  );
}

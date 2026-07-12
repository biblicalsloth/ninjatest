import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

// Admin-only waitlist viewer. Gated on profiles.is_admin (same gate as the
// question-upload console at /admin); the get_waitlist_admin() RPC re-checks
// is_admin server-side as a backstop.
export const dynamic = "force-dynamic";

type Signup = {
  email: string;
  name: string | null;
  phone: string | null;
  year: string | null;
  percentile: string | null;
  section: string | null;
  created_at: string;
};

export default async function AdminWaitlistPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login?next=/admin/waitlist");

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  // is_admin isn't in generated types yet (migration pending) — cast to read it.
  if (!profile || !(profile as { is_admin?: boolean }).is_admin) redirect("/lobby");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("get_waitlist_admin");
  const rows = (data ?? []) as Signup[];

  return (
    <div className="min-h-screen bg-[#120F17] text-white">
      <header className="border-b border-[#222222] px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link href="/lobby" className="text-[#7ab5cc] hover:text-white transition-colors flex items-center gap-1.5 text-sm">
            <ArrowLeft size={14} />
            Back
          </Link>
          <h1 className="text-white font-semibold">Waitlist</h1>
          <div className="w-12" />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {error ? (
          <div className="text-center py-16">
            <p className="text-[#ef476f] font-semibold">Forbidden</p>
            <p className="text-[#4a8fa8] text-sm mt-1">This page is restricted to admins.</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-[#4a8fa8]">No signups yet.</p>
          </div>
        ) : (
          <>
            <p className="text-[#7ab5cc] text-sm mb-4">{rows.length} signup{rows.length === 1 ? "" : "s"}</p>
            <div className="overflow-x-auto rounded-xl border border-[#222222]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[#111111] text-[#7ab5cc] text-left">
                    <th className="px-3 py-2.5 font-medium">Email</th>
                    <th className="px-3 py-2.5 font-medium">Name</th>
                    <th className="px-3 py-2.5 font-medium">Phone</th>
                    <th className="px-3 py-2.5 font-medium">Year</th>
                    <th className="px-3 py-2.5 font-medium">%ile</th>
                    <th className="px-3 py-2.5 font-medium">Section</th>
                    <th className="px-3 py-2.5 font-medium">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.email} className="border-t border-[#222222] text-[#c5e8f0]">
                      <td className="px-3 py-2.5 text-white">{r.email}</td>
                      <td className="px-3 py-2.5">{r.name || "—"}</td>
                      <td className="px-3 py-2.5">{r.phone || "—"}</td>
                      <td className="px-3 py-2.5">{r.year || "—"}</td>
                      <td className="px-3 py-2.5">{r.percentile || "—"}</td>
                      <td className="px-3 py-2.5">{r.section || "—"}</td>
                      <td className="px-3 py-2.5 text-[#7ab5cc] whitespace-nowrap">
                        {new Date(r.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

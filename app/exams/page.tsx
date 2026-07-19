import ExamsClient from "./exams-client";

// Authed-only by middleware (/exams is not a public route). Post-login funnel:
// AuthPanel, the OAuth callback, and the authed-on-/auth redirect all land here.
export default function ExamsPage() {
  return <ExamsClient />;
}

export const dynamic = "force-dynamic";

import SettingsClient from "./settings-client";
import { Enter } from "@/components/enter";

export default function SettingsPage() {
  return (
    <Enter>
      <SettingsClient />
    </Enter>
  );
}

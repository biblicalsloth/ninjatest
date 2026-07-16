"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import type { AiConfig } from "@/lib/ai/model";

// Admin panel for the Ninja model. Writes ai_config; a change takes effect on
// the next /api/ninja/ask with no deploy. The key stays in env — configured
// here is only which OpenRouter model to route to. Every model goes through
// OpenRouter, so switching upstream means changing the model id prefix
// (z-ai/…, google/…, openai/…), not a provider setting.
export function AdminAiConfig() {
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc("get_ai_config").then(({ data }: { data: AiConfig | null }) => setCfg(data));
  }, []);

  async function save() {
    if (!cfg) return;
    setSaving(true);
    const supabase = createClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("admin_set_ai_config", {
      p_model_id: cfg.model_id,
      p_fallback_model_id: cfg.fallback_model_id,
      p_enabled: cfg.enabled,
      p_system_prompt: cfg.system_prompt,
      p_temperature: cfg.temperature,
      p_max_tokens: cfg.max_tokens,
    });
    setSaving(false);
    if (error) toast.error(error.message);
    else toast.success("Ninja config saved");
  }

  if (!cfg) return <p className="text-[#7ab5cc] text-sm">Loading Ninja config…</p>;

  const set = (patch: Partial<AiConfig>) => setCfg({ ...cfg, ...patch });
  const label = "text-[#7ab5cc] text-xs font-medium uppercase tracking-wider";
  const input = "w-full bg-[#120F17] border border-[#333333] rounded-lg px-3 py-2 text-white text-sm focus:border-[#06d6a0] outline-none";

  return (
    <section className="bg-[#111111] rounded-xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-white font-semibold">Ninja AI</h2>
        <label className="flex items-center gap-2 text-sm text-[#c5e8f0]">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Enabled
        </label>
      </div>

      <div className="space-y-1">
        <span className={label}>Model ID</span>
        <input value={cfg.model_id} onChange={(e) => set({ model_id: e.target.value })} className={input}
          placeholder="z-ai/glm-5.2" />
      </div>

      <div className="space-y-1">
        <span className={label}>Fallback model (optional — normally empty)</span>
        <input value={cfg.fallback_model_id ?? ""} onChange={(e) => set({ fallback_model_id: e.target.value || null })}
          className={input} placeholder="leave empty — OpenRouter fails over within the model" />
      </div>

      <div className="space-y-1">
        <span className={label}>System prompt</span>
        <textarea value={cfg.system_prompt} onChange={(e) => set({ system_prompt: e.target.value })}
          rows={4} className={input + " resize-y"} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <span className={label}>Temperature</span>
          <input type="number" step="0.1" min="0" max="2" value={cfg.temperature}
            onChange={(e) => set({ temperature: Number(e.target.value) })} className={input} />
        </div>
        <div className="space-y-1">
          <span className={label}>Max tokens</span>
          <input type="number" step="100" min="1" max="8000" value={cfg.max_tokens}
            onChange={(e) => set({ max_tokens: Number(e.target.value) })} className={input} />
        </div>
      </div>

      <Button onClick={save} disabled={saving}
        className="h-10 bg-[#06d6a0] text-[#073b4c] font-semibold rounded-full hover:bg-[#05b088] px-6">
        {saving ? "Saving…" : "Save Ninja config"}
      </Button>
    </section>
  );
}

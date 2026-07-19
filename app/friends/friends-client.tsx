"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  UserPlus,
  Check,
  X,
  Swords,
  MessageSquare,
  Trash2,
  Send,
  ArrowLeft,
  Search,
  Clock,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useChallengeAccepted } from "@/lib/hooks/use-challenge-accepted";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

interface FriendRow {
  other_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  elo: number;
  relation: "accepted" | "incoming" | "outgoing";
}

interface SearchResult {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  elo: number;
}

interface IncomingChallenge {
  code: string;
  host_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  elo: number;
  is_rated: boolean;
  section_mode: "VARC" | "DILR" | "QUANT" | null;
  expires_at: string;
}

interface Message {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  created_at: string;
}

interface Props {
  myId: string;
}

export default function FriendsClient({ myId }: Props) {
  const router = useRouter();
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [challenges, setChallenges] = useState<IncomingChallenge[]>([]);
  const [sentCode, setSentCode] = useState<string | null>(null);
  // Route the host into the match the moment the friend accepts.
  useChallengeAccepted(sentCode);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});

  const [openWith, setOpenWith] = useState<FriendRow | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const openWithRef = useRef<string | null>(null);
  openWithRef.current = openWith?.other_id ?? null;

  const supabaseRef = useRef(createClient());
  const supabase = supabaseRef.current;

  const loadFriends = useCallback(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any).rpc("get_friends");
    setFriends((data ?? []) as FriendRow[]);
  }, [supabase]);

  const loadChallenges = useCallback(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any).rpc("get_incoming_challenges");
    setChallenges((data ?? []) as IncomingChallenge[]);
  }, [supabase]);

  useEffect(() => {
    loadFriends();
    loadChallenges();
  }, [loadFriends, loadChallenges]);

  // Realtime: any DM addressed to me. Append to the open thread (and mark read)
  // or bump the sender's unread badge.
  useEffect(() => {
    const channel = supabase
      .channel(`dm:${myId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "direct_messages", filter: `recipient_id=eq.${myId}` },
        (payload) => {
          const msg = payload.new as Message;
          if (openWithRef.current === msg.sender_id) {
            setMessages((m) => [...m, msg]);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (supabase as any).rpc("mark_messages_read", { p_other_id: msg.sender_id });
          } else {
            setUnread((u) => ({ ...u, [msg.sender_id]: (u[msg.sender_id] ?? 0) + 1 }));
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [supabase, myId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function openThread(f: FriendRow) {
    setOpenWith(f);
    setMessages([]);
    setUnread((u) => ({ ...u, [f.other_id]: 0 }));
    const { data } = await supabase
      .from("direct_messages")
      .select("id, sender_id, recipient_id, body, created_at")
      .or(
        `and(sender_id.eq.${myId},recipient_id.eq.${f.other_id}),and(sender_id.eq.${f.other_id},recipient_id.eq.${myId})`
      )
      .order("created_at", { ascending: true })
      .limit(200);
    setMessages((data ?? []) as Message[]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).rpc("mark_messages_read", { p_other_id: f.other_id });
  }

  async function handleSend() {
    const body = draft.trim();
    if (!body || !openWith || sending) return;
    setSending(true);
    setDraft("");
    // optimistic
    const optimistic: Message = {
      id: `tmp-${messages.length}`,
      sender_id: myId,
      recipient_id: openWith.other_id,
      body,
      created_at: new Date(0).toISOString(),
    };
    setMessages((m) => [...m, optimistic]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("send_message", {
      p_recipient_id: openWith.other_id,
      p_body: body,
    });
    if (error) {
      toast.error(error.message ?? "Failed to send");
      setMessages((m) => m.filter((x) => x.id !== optimistic.id));
      setDraft(body);
    }
    setSending(false);
  }

  async function handleSearch(q: string) {
    setQuery(q);
    if (q.trim().length < 2) { setResults([]); return; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any).rpc("search_profiles", { p_query: q, p_limit: 8 });
    setResults((data ?? []) as SearchResult[]);
  }

  async function sendRequest(id: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("send_friend_request", { p_target_id: id });
    if (error) { toast.error(error.message ?? "Failed"); return; }
    toast.success("Request sent");
    setResults((r) => r.filter((u) => u.id !== id));
    loadFriends();
  }

  async function respond(otherId: string, accept: boolean) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("respond_friend_request", { p_other_id: otherId, p_accept: accept });
    if (error) { toast.error(error.message ?? "Failed"); return; }
    loadFriends();
  }

  async function removeFriend(otherId: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("remove_friend", { p_other_id: otherId });
    if (error) { toast.error(error.message ?? "Failed"); return; }
    if (openWith?.other_id === otherId) setOpenWith(null);
    loadFriends();
  }

  async function challengeFriend(f: FriendRow) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: code, error } = await (supabase as any).rpc("create_challenge", {
      p_is_rated: true,
      p_section_mode: null,
      p_target_id: f.other_id,
    });
    if (error || !code) { toast.error("Failed to create challenge"); return; }
    setSentCode(code as string);
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/c/${code}`);
    } catch { /* clipboard optional */ }
    toast.success(`Challenge sent to ${f.display_name ?? f.username} — link copied`);
  }

  async function acceptChallenge(code: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("accept_challenge", { p_code: code });
    if (error || !data) { toast.error(error?.message ?? "Failed to accept"); loadChallenges(); return; }
    router.push(`/match/${data}`);
  }

  const accepted = friends.filter((f) => f.relation === "accepted");
  const incoming = friends.filter((f) => f.relation === "incoming");
  const outgoing = friends.filter((f) => f.relation === "outgoing");

  return (
    <div className="min-h-screen bg-[#120F17] text-white">
      <div className="max-w-5xl mx-auto px-4 pt-6">
        <PageHeader
          label="Friends"
          sub="Add rivals, chat, and send battle invites"
        />
      </div>

      <main className="max-w-5xl mx-auto px-4 pt-6 grid grid-cols-1 lg:grid-cols-2 gap-6 pb-24">
        {/* Left: people */}
        <section className={cn("space-y-6", openWith && "hidden lg:block")}>
          {/* Add friend */}
          <div className="bg-[#111111] border border-[#1c1a24] rounded-xl p-4">
            <h2 className="text-[#7ab5cc] text-sm font-medium mb-2.5">Add a friend</h2>
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4a8fa8]" />
              <Input
                value={query}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder="Search players to add…"
                className="pl-9 bg-[#120F17] border-[#222222] text-white"
              />
            </div>
            {results.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {results.map((u) => (
                  <Row key={u.id} username={u.username} display={u.display_name} avatar={u.avatar_url} elo={u.elo}>
                    <IconBtn onClick={() => sendRequest(u.id)} title="Add friend" tone="mint">
                      <UserPlus size={15} />
                    </IconBtn>
                  </Row>
                ))}
              </div>
            )}
          </div>

          {/* Incoming challenges */}
          {challenges.length > 0 && (
            <Group label="Battle invites">
              {challenges.map((c) => (
                <Row key={c.code} username={c.username} display={c.display_name} avatar={c.avatar_url} elo={c.elo}
                  sub={`${c.is_rated ? "Rated" : "Casual"} · ${c.section_mode ?? "Mixed"}`}>
                  <Button
                    onClick={() => acceptChallenge(c.code)}
                    className="h-8 px-3 bg-[#06d6a0] text-[#073b4c] font-semibold rounded-full hover:bg-[#05b088]"
                  >
                    <Swords size={14} className="mr-1" /> Play
                  </Button>
                </Row>
              ))}
            </Group>
          )}

          {/* Incoming friend requests */}
          {incoming.length > 0 && (
            <Group label="Friend requests">
              {incoming.map((f) => (
                <Row key={f.other_id} username={f.username} display={f.display_name} avatar={f.avatar_url} elo={f.elo}>
                  <IconBtn onClick={() => respond(f.other_id, true)} title="Accept" tone="mint">
                    <Check size={15} />
                  </IconBtn>
                  <IconBtn onClick={() => respond(f.other_id, false)} title="Reject" tone="pink">
                    <X size={15} />
                  </IconBtn>
                </Row>
              ))}
            </Group>
          )}

          {/* Friends */}
          <Group label={`Friends${accepted.length ? ` (${accepted.length})` : ""}`}>
            {accepted.length === 0 && (
              <div className="bg-[#111111] border border-[#1c1a24] rounded-xl px-6 py-10 text-center">
                <UserPlus size={24} className="mx-auto mb-2.5 text-[#4a8fa8]" />
                <p className="text-white text-sm font-medium">No friends yet</p>
                <p className="text-[#4a8fa8] text-xs mt-1">
                  Search a username above — once they accept, you can chat and challenge them to a battle.
                </p>
              </div>
            )}
            {accepted.map((f) => (
              <Row key={f.other_id} username={f.username} display={f.display_name} avatar={f.avatar_url} elo={f.elo}
                onClick={() => openThread(f)} active={openWith?.other_id === f.other_id} badge={unread[f.other_id]}>
                <IconBtn onClick={() => challengeFriend(f)} title="Challenge" tone="mint">
                  <Swords size={15} />
                </IconBtn>
                <IconBtn onClick={() => openThread(f)} title="Message" tone="blue">
                  <MessageSquare size={15} />
                </IconBtn>
                <IconBtn onClick={() => removeFriend(f.other_id)} title="Remove" tone="pink">
                  <Trash2 size={15} />
                </IconBtn>
              </Row>
            ))}
          </Group>

          {/* Outgoing (pending) */}
          {outgoing.length > 0 && (
            <Group label="Sent requests">
              {outgoing.map((f) => (
                <Row key={f.other_id} username={f.username} display={f.display_name} avatar={f.avatar_url} elo={f.elo}>
                  <span className="flex items-center gap-1 text-[#4a8fa8] text-xs">
                    <Clock size={13} /> Pending
                  </span>
                </Row>
              ))}
            </Group>
          )}
        </section>

        {/* Right: conversation */}
        <section className={cn("lg:sticky lg:top-6 lg:h-[calc(100vh-6rem)]", !openWith && "hidden lg:flex")}>
          {openWith ? (
            <div className="flex flex-col w-full h-[70vh] lg:h-full bg-[#111111] rounded-xl overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 border-b border-[#1c1a24]">
                <button className="lg:hidden text-[#7ab5cc]" onClick={() => setOpenWith(null)}>
                  <ArrowLeft size={18} />
                </button>
                <Avatar className="w-8 h-8">
                  <AvatarImage src={openWith.avatar_url ?? undefined} />
                  <AvatarFallback className="bg-[#120F17] text-[#06d6a0] text-xs font-bold">
                    {openWith.username.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{openWith.display_name ?? openWith.username}</p>
                  <p className="text-[#7ab5cc] text-xs">@{openWith.username}</p>
                </div>
                <IconBtn onClick={() => challengeFriend(openWith)} title="Challenge" tone="mint">
                  <Swords size={15} />
                </IconBtn>
              </div>

              <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
                {messages.length === 0 && (
                  <p className="text-[#4a8fa8] text-sm text-center mt-6">Say hi to {openWith.display_name ?? openWith.username}.</p>
                )}
                {messages.map((m) => {
                  const mine = m.sender_id === myId;
                  return (
                    <div key={m.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
                      <div className={cn(
                        "max-w-[75%] rounded-2xl px-3 py-2 text-sm break-words",
                        mine ? "bg-[#06d6a0] text-[#073b4c]" : "bg-[#1c1a24] text-white"
                      )}>
                        {m.body}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center gap-2 p-3 border-t border-[#1c1a24]">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  placeholder="Message…"
                  maxLength={2000}
                  className="bg-[#120F17] border-[#222222] text-white"
                />
                <Button
                  onClick={handleSend}
                  disabled={sending || !draft.trim()}
                  className="h-9 w-9 p-0 bg-[#06d6a0] text-[#073b4c] rounded-full hover:bg-[#05b088] disabled:opacity-50 shrink-0"
                >
                  <Send size={16} />
                </Button>
              </div>
            </div>
          ) : (
            <div className="hidden lg:flex flex-col items-center justify-center w-full h-full bg-[#111111] rounded-xl text-[#4a8fa8]">
              <MessageSquare size={28} className="mb-2" />
              <p className="text-sm">Pick a friend to start chatting.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-[#7ab5cc] text-sm font-medium mb-2">{label}</h2>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({
  username, display, avatar, elo, sub, children, onClick, active, badge,
}: {
  username: string;
  display: string | null;
  avatar: string | null;
  elo: number;
  sub?: string;
  children?: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  badge?: number;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "bg-[#111111] rounded-lg px-3 py-2.5 flex items-center gap-3",
        onClick && "cursor-pointer hover:bg-[#161320]",
        active && "ring-1 ring-[#06d6a0]/50"
      )}
    >
      <div className="relative shrink-0">
        <Avatar className="w-9 h-9">
          <AvatarImage src={avatar ?? undefined} />
          <AvatarFallback className="bg-[#120F17] text-[#06d6a0] text-xs font-bold">
            {username.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        {badge ? (
          <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-[#ef476f] text-white text-[10px] font-bold flex items-center justify-center">
            {badge}
          </span>
        ) : null}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-medium truncate">{display ?? username}</p>
        <p className="text-[#7ab5cc] text-xs truncate">{sub ?? `@${username} · ${elo}`}</p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function IconBtn({
  children, onClick, title, tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  tone: "mint" | "pink" | "blue";
}) {
  const color =
    tone === "mint" ? "text-[#06d6a0] hover:bg-[#06d6a0]/15"
    : tone === "pink" ? "text-[#ef476f] hover:bg-[#ef476f]/15"
    : "text-[#7ab5cc] hover:bg-[#7ab5cc]/15";
  return (
    <button onClick={onClick} title={title} className={cn("w-8 h-8 rounded-full flex items-center justify-center transition-colors", color)}>
      {children}
    </button>
  );
}

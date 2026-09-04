import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  ImagePlus,
  Mic,
  Phone,
  Send,
  Square,
  Video,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Profile } from "@/hooks/useAuth";
import { uploadFile } from "@/lib/media";
import { useSignedUrl } from "@/components/SignedImage";
import { UserAvatar } from "./UserAvatar";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export type Message = {
  id: string;
  sender_id: string;
  receiver_id: string;
  content: string | null;
  kind: string;
  media_url: string | null;
  read_at: string | null;
  created_at: string;
};

function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function MediaBubble({ path, kind }: { path: string | null; kind: string }) {
  const url = useSignedUrl("chat-media", path);
  if (!url) return <div className="h-40 w-52 animate-pulse rounded-lg bg-muted" />;
  if (kind === "image")
    return <img src={url} alt="Shared" loading="lazy" className="max-h-64 rounded-lg" />;
  if (kind === "video")
    return <video src={url} controls playsInline className="max-h-64 rounded-lg" />;
  return <audio src={url} controls className="w-56" />;
}

export function ChatWindow({
  me,
  peer,
  onBack,
  onCall,
}: {
  me: Profile;
  peer: Profile;
  onBack: () => void;
  onCall: (kind: "audio" | "video") => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data } = await supabase
        .from("messages")
        .select("*")
        .or(
          `and(sender_id.eq.${me.id},receiver_id.eq.${peer.id}),and(sender_id.eq.${peer.id},receiver_id.eq.${me.id})`,
        )
        .order("created_at", { ascending: true })
        .limit(300);
      if (active) setMessages((data as Message[]) ?? []);
    };
    void load();

    const channel = supabase
      .channel(`chat-${me.id}-${peer.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        ({ eventType, new: row }) => {
          const msg = row as Message;
          const inThread =
            (msg.sender_id === me.id && msg.receiver_id === peer.id) ||
            (msg.sender_id === peer.id && msg.receiver_id === me.id);
          if (!inThread) return;
          setMessages((prev) => {
            if (eventType === "INSERT") {
              if (prev.some((m) => m.id === msg.id)) return prev;
              return [...prev, msg];
            }
            return prev.map((m) => (m.id === msg.id ? msg : m));
          });
        },
      )
      .subscribe();

    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [me.id, peer.id]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
    const unread = messages.filter((m) => m.sender_id === peer.id && !m.read_at);
    if (unread.length && peer.read_receipts) {
      void supabase
        .from("messages")
        .update({ read_at: new Date().toISOString() })
        .in(
          "id",
          unread.map((m) => m.id),
        );
    }
  }, [messages, peer.id]);

  const insertMessage = async (payload: Partial<Message>) => {
    const { error } = await supabase.from("messages").insert({
      sender_id: me.id,
      receiver_id: peer.id,
      kind: "text",
      ...payload,
    } as never);
    if (error) toast.error(error.message);
  };

  const sendText = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText("");
    await insertMessage({ content: body, kind: "text" });
  };

  const sendFile = async (file: File) => {
    setSending(true);
    try {
      const kind = file.type.startsWith("video") ? "video" : "image";
      const ext = file.name.split(".").pop() || (kind === "video" ? "mp4" : "jpg");
      const path = await uploadFile("chat-media", me.id, file, ext);
      await insertMessage({ kind, media_url: path });
    } catch {
      toast.error("Could not send that file.");
    } finally {
      setSending(false);
    }
  };

  const toggleRecording = async () => {
    if (recording) {
      recorder.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunks.current = [];
      rec.ondataavailable = (e) => chunks.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: "audio/webm" });
        try {
          const path = await uploadFile("chat-media", me.id, blob, "webm");
          await insertMessage({ kind: "voice", media_url: path });
        } catch {
          toast.error("Could not send the voice note.");
        }
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
    } catch {
      toast.error("Microphone permission is needed for voice notes.");
    }
  };

  const lastSeen =
    peer.show_last_seen && peer.last_seen
      ? Date.now() - new Date(peer.last_seen).getTime() < 90_000
        ? "online"
        : `last seen ${new Date(peer.last_seen).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })}`
      : "";

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-surface px-3 py-2.5">
        <button onClick={onBack} className="rounded-md p-1 hover:bg-muted md:hidden" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <UserAvatar path={peer.avatar_url} name={peer.display_name || peer.username} size={38} hidden={!peer.show_avatar} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{peer.display_name || peer.username}</p>
          <p className="truncate text-[11px] text-muted-foreground">{lastSeen}</p>
        </div>
        <button onClick={() => onCall("audio")} className="rounded-md p-2 hover:bg-muted" aria-label="Voice call">
          <Phone className="h-[18px] w-[18px]" />
        </button>
        <button onClick={() => onCall("video")} className="rounded-md p-2 hover:bg-muted" aria-label="Video call">
          <Video className="h-[18px] w-[18px]" />
        </button>
      </header>

      <div className="chat-canvas flex-1 space-y-2 overflow-y-auto px-3 py-4">
        {messages.map((m) => {
          const mine = m.sender_id === me.id;
          return (
            <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[78%] rounded-2xl px-2.5 py-1.5 shadow-sm ${
                  mine
                    ? "rounded-br-sm bg-bubble-out text-bubble-out-foreground"
                    : "rounded-bl-sm bg-bubble-in text-bubble-in-foreground"
                }`}
              >
                {m.kind === "text" ? (
                  <p className="whitespace-pre-wrap break-words px-1 text-sm">{m.content}</p>
                ) : (
                  <MediaBubble path={m.media_url} kind={m.kind} />
                )}
                <div className="flex items-center justify-end gap-1 px-1 pt-0.5 text-[10px] opacity-70">
                  <span>{timeOf(m.created_at)}</span>
                  {mine &&
                    (m.read_at ? (
                      <CheckCheck className="h-3 w-3 text-primary" />
                    ) : (
                      <Check className="h-3 w-3" />
                    ))}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>

      <form onSubmit={sendText} className="flex items-end gap-1.5 border-t border-border bg-surface px-2 py-2">
        <input
          ref={fileInput}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void sendFile(file);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="rounded-full p-2.5 text-muted-foreground hover:bg-muted"
          aria-label="Send photo or video"
          disabled={sending}
        >
          <ImagePlus className="h-5 w-5" />
        </button>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendText(e);
            }
          }}
          rows={1}
          placeholder="Message"
          className="max-h-28 min-h-10 flex-1 resize-none rounded-2xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
        />
        {text.trim() ? (
          <Button type="submit" size="icon" className="h-10 w-10 shrink-0 rounded-full">
            <Send className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            variant={recording ? "destructive" : "default"}
            className="h-10 w-10 shrink-0 rounded-full"
            onClick={() => void toggleRecording()}
            aria-label={recording ? "Stop recording" : "Record voice note"}
          >
            {recording ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </Button>
        )}
      </form>
    </div>
  );
}

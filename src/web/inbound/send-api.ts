import type { AnyMessageContent, WAPresence } from "@whiskeysockets/baileys";
import { recordChannelActivity } from "../../infra/channel-activity.js";
import { toWhatsappJid } from "../../utils.js";
import type { ActiveWebSendOptions } from "../active-listener.js";

function recordWhatsAppOutbound(accountId: string) {
  recordChannelActivity({
    channel: "whatsapp",
    accountId,
    direction: "outbound",
  });
}

function resolveOutboundMessageId(result: unknown): string {
  return typeof result === "object" && result && "key" in result
    ? String((result as { key?: { id?: string } }).key?.id ?? "unknown")
    : "unknown";
}

export function createWebSendApi(params: {
  sock: {
    sendMessage: (jid: string, content: AnyMessageContent) => Promise<unknown>;
    sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
    updateProfilePicture?: (jid: string, content: Buffer) => Promise<void>;
    groupMetadata?: (jid: string) => Promise<{ participants: { id: string }[] }>;
    user?: { id: string };
  };
  defaultAccountId: string;
  getFullMessage?: (key: {
    remoteJid?: string | null;
    id?: string | null;
  }) => { key?: { fromMe?: boolean | null; participant?: string | null } } | undefined;
  storeMessage?: (msg: import("@whiskeysockets/baileys").WAMessage) => void;
  removeProfilePictureFn?: () => Promise<void>;
}) {
  return {
    sendMessage: async (
      to: string,
      text: string,
      mediaBuffer?: Buffer,
      mediaType?: string,
      sendOptions?: ActiveWebSendOptions,
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      let payload: AnyMessageContent;
      if (mediaBuffer && mediaType) {
        if (mediaType.startsWith("image/")) {
          payload = {
            image: mediaBuffer,
            caption: text || undefined,
            mimetype: mediaType,
          };
        } else if (mediaType.startsWith("audio/")) {
          payload = { audio: mediaBuffer, ptt: true, mimetype: mediaType };
        } else if (mediaType.startsWith("video/")) {
          const gifPlayback = sendOptions?.gifPlayback;
          payload = {
            video: mediaBuffer,
            caption: text || undefined,
            mimetype: mediaType,
            ...(gifPlayback ? { gifPlayback: true } : {}),
          };
        } else {
          const fileName = sendOptions?.fileName?.trim() || "file";
          payload = {
            document: mediaBuffer,
            fileName,
            caption: text || undefined,
            mimetype: mediaType,
          };
        }
      } else {
        let mentions = sendOptions?.mentions;
        // mentionAll: fetch all group participants and use them as mentions
        if (sendOptions?.mentionAll && params.sock.groupMetadata) {
          const jidForMeta = toWhatsappJid(to);
          const meta = await params.sock.groupMetadata(jidForMeta);
          const selfJid = params.sock.user?.id?.replace(/@.*$/, "") ?? "";
          mentions = meta.participants
            .map((p) => p.id)
            .filter((jid) => jid.replace(/@.*$/, "") !== selfJid);
        }
        // WhatsApp requires @{number} in the text to render blue mentions.
        // For @s.whatsapp.net JIDs: use phone number (e.g. @420724535280)
        // For @lid JIDs: use lid number (e.g. @277712669282525) - WA resolves to display name
        let mentionText = text;
        if (sendOptions?.mentionAll && !mentionText.includes("@all")) {
          mentionText = `${mentionText} @all`;
        }
        if (mentions?.length && !sendOptions?.mentionAll) {
          for (const mentionJid of mentions) {
            const num = mentionJid.replace(/@.*$/, "");
            if (!num) {
              continue;
            }
            const isLid = mentionJid.endsWith("@lid");
            // For @lid: only check @num (no + prefix). For @s.whatsapp.net: check both @num and @+num.
            const alreadyPresent = isLid
              ? mentionText.includes(`@${num}`)
              : mentionText.includes(`@${num}`) || mentionText.includes(`@+${num}`);
            if (!alreadyPresent) {
              mentionText = `${mentionText} @${num}`;
            }
          }
        }
        payload = mentions?.length ? { text: mentionText, mentions } : { text };
      }
      const result = await params.sock.sendMessage(jid, payload);
      const accountId = sendOptions?.accountId ?? params.defaultAccountId;
      recordWhatsAppOutbound(accountId);
      const messageId = resolveOutboundMessageId(result);
      return { messageId };
    },
    sendPoll: async (
      to: string,
      poll: { question: string; options: string[]; maxSelections?: number },
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      const result = await params.sock.sendMessage(jid, {
        poll: {
          name: poll.question,
          values: poll.options,
          selectableCount: poll.maxSelections ?? 1,
        },
      } as AnyMessageContent);
      recordWhatsAppOutbound(params.defaultAccountId);
      const messageId = resolveOutboundMessageId(result);
      // Store poll creation message so vote decryption works later
      if (result && params.storeMessage) {
        params.storeMessage(result as import("@whiskeysockets/baileys").WAMessage);
      }
      return { messageId };
    },
    sendReaction: async (
      chatJid: string,
      messageId: string,
      emoji: string,
      fromMe: boolean,
      participant?: string,
    ): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      // Auto-resolve fromMe and participant from message store if not provided
      let resolvedFromMe = fromMe;
      let resolvedParticipant = participant ? toWhatsappJid(participant) : undefined;
      if (params.getFullMessage) {
        const stored = params.getFullMessage({ remoteJid: jid, id: messageId });
        if (stored) {
          if (!resolvedFromMe && stored.key?.fromMe === true) {
            resolvedFromMe = true;
          }
          if (!resolvedParticipant && stored.key?.participant) {
            resolvedParticipant = stored.key.participant;
          }
        }
      }
      await params.sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: jid,
            id: messageId,
            fromMe: resolvedFromMe,
            participant: resolvedParticipant,
          },
        },
      } as AnyMessageContent);
    },
    sendComposingTo: async (to: string): Promise<void> => {
      const jid = toWhatsappJid(to);
      await params.sock.sendPresenceUpdate("composing", jid);
    },
    updateProfilePicture: async (imageBuffer: Buffer): Promise<void> => {
      if (!params.sock.updateProfilePicture) {
        throw new Error("updateProfilePicture is not supported by this socket.");
      }
      const myJid = params.sock.user?.id ?? "";
      await params.sock.updateProfilePicture(myJid, imageBuffer);
    },
    removeProfilePicture: params.removeProfilePictureFn
      ? async (): Promise<void> => {
          await params.removeProfilePictureFn!();
        }
      : undefined,
    pinMessage: async (
      chatJid: string,
      messageId: string,
      type: 1 | 2, // 1 = PIN_FOR_ALL, 2 = UNPIN_FOR_ALL
      duration?: number,
      fromMe?: boolean,
    ): Promise<void> => {
      const normalizedJid = toWhatsappJid(chatJid);
      const key: Record<string, unknown> = { remoteJid: normalizedJid, id: messageId };
      if (typeof fromMe === "boolean") {
        key.fromMe = fromMe;
      }
      const content: Record<string, unknown> = { pin: key, type };
      if (duration !== undefined) {
        content.time = duration;
      }
      await params.sock.sendMessage(
        normalizedJid,
        content as Parameters<typeof params.sock.sendMessage>[1],
      );
    },
  } as const;
}

import type { AnyMessageContent, proto, WAMessage } from "@whiskeysockets/baileys";
import {
  DisconnectReason,
  getAggregateVotesInPollMessage,
  isJidGroup,
} from "@whiskeysockets/baileys";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - internal Baileys export not in public types
import { decryptPollVote } from "@whiskeysockets/baileys/lib/Utils/process-message.js";
import { createInboundDebouncer } from "../../auto-reply/inbound-debounce.js";
import { formatLocationText } from "../../channels/location.js";
import { loadConfig } from "../../config/config.js";
import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { recordChannelActivity } from "../../infra/channel-activity.js";
import { getChildLogger } from "../../logging/logger.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { saveMediaBuffer } from "../../media/store.js";
import { jidToE164, resolveJidToE164 } from "../../utils.js";
import { createWaSocket, getStatusCode, waitForWaConnection } from "../session.js";
import { checkInboundAccessControl } from "./access-control.js";
import { isRecentInboundMessage } from "./dedupe.js";
import {
  describeReplyContext,
  extractLocationData,
  extractMediaPlaceholder,
  extractMentionedJids,
  extractText,
} from "./extract.js";
import { downloadInboundMedia } from "./media.js";
import { createWebSendApi } from "./send-api.js";
import type { WebInboundMessage, WebListenerCloseReason } from "./types.js";

export async function monitorWebInbox(options: {
  verbose: boolean;
  accountId: string;
  authDir: string;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  mediaMaxMb?: number;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Optional debounce gating predicate. */
  shouldDebounce?: (msg: WebInboundMessage) => boolean;
}) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  // --- Poll vote support: LRU message store for poll vote decryption ---
  const MSG_STORE_MAX = 500;
  const msgStoreKeys: string[] = [];
  const msgStore = new Map<string, WAMessage>();

  const storeMessage = (msg: WAMessage) => {
    const storeKey = `${msg.key?.remoteJid}:${msg.key?.id}`;
    if (!msgStore.has(storeKey)) {
      msgStoreKeys.push(storeKey);
      if (msgStoreKeys.length > MSG_STORE_MAX) {
        const evicted = msgStoreKeys.shift();
        if (evicted) {
          msgStore.delete(evicted);
        }
      }
    }
    msgStore.set(storeKey, msg);
  };

  const getMessage = async (key: WAMessage["key"]): Promise<proto.IMessage | undefined> => {
    const storeKey = `${key?.remoteJid}:${key?.id}`;
    return msgStore.get(storeKey)?.message ?? undefined;
  };

  const getFullMessage = (key: WAMessage["key"]): WAMessage | undefined => {
    const storeKey = `${key?.remoteJid}:${key?.id}`;
    return msgStore.get(storeKey);
  };

  const sock = await createWaSocket(false, options.verbose, {
    authDir: options.authDir,
    getMessage,
  });
  await waitForWaConnection(sock);
  const connectedAtMs = Date.now();

  let onCloseResolve: ((reason: WebListenerCloseReason) => void) | null = null;
  const onClose = new Promise<WebListenerCloseReason>((resolve) => {
    onCloseResolve = resolve;
  });
  const resolveClose = (reason: WebListenerCloseReason) => {
    if (!onCloseResolve) {
      return;
    }
    const resolver = onCloseResolve;
    onCloseResolve = null;
    resolver(reason);
  };

  try {
    await sock.sendPresenceUpdate("available");
    if (shouldLogVerbose()) {
      logVerbose("Sent global 'available' presence on connect");
    }
  } catch (err) {
    logVerbose(`Failed to send 'available' presence on connect: ${String(err)}`);
  }

  const selfJid = sock.user?.id;
  const selfE164 = selfJid ? jidToE164(selfJid) : null;
  const debouncer = createInboundDebouncer<WebInboundMessage>({
    debounceMs: options.debounceMs ?? 0,
    buildKey: (msg) => {
      const senderKey =
        msg.chatType === "group"
          ? (msg.senderJid ?? msg.senderE164 ?? msg.senderName ?? msg.from)
          : msg.from;
      if (!senderKey) {
        return null;
      }
      const conversationKey = msg.chatType === "group" ? msg.chatId : msg.from;
      return `${msg.accountId}:${conversationKey}:${senderKey}`;
    },
    shouldDebounce: options.shouldDebounce,
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await options.onMessage(last);
        return;
      }
      const mentioned = new Set<string>();
      for (const entry of entries) {
        for (const jid of entry.mentionedJids ?? []) {
          mentioned.add(jid);
        }
      }
      const combinedBody = entries
        .map((entry) => entry.body)
        .filter(Boolean)
        .join("\n");
      const combinedMessage: WebInboundMessage = {
        ...last,
        body: combinedBody,
        mentionedJids: mentioned.size > 0 ? Array.from(mentioned) : undefined,
      };
      await options.onMessage(combinedMessage);
    },
    onError: (err) => {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    },
  });
  const groupMetaCache = new Map<
    string,
    { subject?: string; participants?: string[]; expires: number }
  >();
  const GROUP_META_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const lidLookup = sock.signalRepository?.lidMapping;

  const resolveInboundJid = async (jid: string | null | undefined): Promise<string | null> =>
    resolveJidToE164(jid, { authDir: options.authDir, lidLookup });

  const getGroupMeta = async (jid: string) => {
    const cached = groupMetaCache.get(jid);
    if (cached && cached.expires > Date.now()) {
      return cached;
    }
    try {
      const meta = await sock.groupMetadata(jid);
      const participants =
        (
          await Promise.all(
            meta.participants?.map(async (p) => {
              const mapped = await resolveInboundJid(p.id);
              return mapped ?? p.id;
            }) ?? [],
          )
        ).filter(Boolean) ?? [];
      const entry = {
        subject: meta.subject,
        participants,
        expires: Date.now() + GROUP_META_TTL_MS,
      };
      groupMetaCache.set(jid, entry);
      return entry;
    } catch (err) {
      logVerbose(`Failed to fetch group metadata for ${jid}: ${String(err)}`);
      return { expires: Date.now() + GROUP_META_TTL_MS };
    }
  };

  const handleMessagesUpsert = async (upsert: { type?: string; messages?: Array<WAMessage> }) => {
    if (upsert.type !== "notify" && upsert.type !== "append") {
      return;
    }
    for (const msg of upsert.messages ?? []) {
      storeMessage(msg);
      if (msg.message) {
      }
      recordChannelActivity({
        channel: "whatsapp",
        accountId: options.accountId,
        direction: "inbound",
      });
      const id = msg.key?.id ?? undefined;
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid) {
        continue;
      }
      if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
        continue;
      }

      const group = isJidGroup(remoteJid) === true;
      if (id) {
        const dedupeKey = `${options.accountId}:${remoteJid}:${id}`;
        if (isRecentInboundMessage(dedupeKey)) {
          continue;
        }
      }
      const participantJid = msg.key?.participant ?? undefined;
      const from = group ? remoteJid : await resolveInboundJid(remoteJid);
      if (!from) {
        continue;
      }
      const senderE164 = group
        ? participantJid
          ? await resolveInboundJid(participantJid)
          : null
        : from;

      let groupSubject: string | undefined;
      let groupParticipants: string[] | undefined;
      if (group) {
        const meta = await getGroupMeta(remoteJid);
        groupSubject = meta.subject;
        groupParticipants = meta.participants;
      }
      const messageTimestampMs = msg.messageTimestamp
        ? Number(msg.messageTimestamp) * 1000
        : undefined;

      const access = await checkInboundAccessControl({
        accountId: options.accountId,
        from,
        selfE164,
        senderE164,
        group,
        pushName: msg.pushName ?? undefined,
        isFromMe: Boolean(msg.key?.fromMe),
        messageTimestampMs,
        connectedAtMs,
        sock: { sendMessage: (jid, content) => sock.sendMessage(jid, content) },
        remoteJid,
      });
      logVerbose(
        `access-check: remoteJid=${remoteJid} group=${group} allowed=${access.allowed} senderE164=${senderE164 ?? "null"}`,
      );
      if (!access.allowed) {
        continue;
      }

      if (id && !access.isSelfChat && options.sendReadReceipts !== false) {
        const participant = msg.key?.participant;
        try {
          await sock.readMessages([{ remoteJid, id, participant, fromMe: false }]);
          if (shouldLogVerbose()) {
            const suffix = participant ? ` (participant ${participant})` : "";
            logVerbose(`Marked message ${id} as read for ${remoteJid}${suffix}`);
          }
        } catch (err) {
          logVerbose(`Failed to mark message ${id} read: ${String(err)}`);
        }
      } else if (id && access.isSelfChat && shouldLogVerbose()) {
        // Self-chat mode: never auto-send read receipts (blue ticks) on behalf of the owner.
        logVerbose(`Self-chat mode: skipping read receipt for ${id}`);
      }

      // If this is history/offline catch-up, mark read above but skip auto-reply.
      if (upsert.type === "append") {
        continue;
      }

      const location = extractLocationData(msg.message ?? undefined);
      const locationText = location ? formatLocationText(location) : undefined;
      let body = extractText(msg.message ?? undefined);
      if (locationText) {
        body = [body, locationText].filter(Boolean).join("\n").trim();
      }
      const reaction = msg.message?.reactionMessage;
      if (reaction) {
        const cfg = loadConfig();
        const reactionsEnabled = cfg?.channels?.whatsapp?.inbound?.reactions === true;
        if (!reactionsEnabled) {
          continue;
        }
        const emoji = reaction.text ?? "";
        const targetId = reaction.key?.id ?? "unknown";
        body = emoji
          ? "[Reaction " + emoji + " on message " + targetId + "]"
          : "[Reaction removed on message " + targetId + "]";
      }
      // Handle pin/unpin messages
      const pinInChat = msg.message?.pinInChatMessage;
      if (pinInChat) {
        const cfg = loadConfig();
        const pinsEnabled = cfg?.channels?.whatsapp?.inbound?.pins === true;
        if (!pinsEnabled) {
          continue;
        }
        const pinnedMsgId = pinInChat.key?.id ?? "unknown";
        const pinType = Number(pinInChat.type);
        // type 1 = PIN_FOR_ALL, type 2 = UNPIN_FOR_ALL
        body =
          pinType === 2 ? `[Unpinned message ${pinnedMsgId}]` : `[Pinned message ${pinnedMsgId}]`;
      }
      // Handle poll vote messages
      const pollUpdate = msg.message?.pollUpdateMessage;
      if (pollUpdate) {
        const cfg = loadConfig();
        const pollVotesMode = cfg?.channels?.whatsapp?.inbound?.pollVotes ?? "none";
        if (pollVotesMode === "none") {
          continue;
        }
        const creationMsgKey = pollUpdate.pollCreationMessageKey;
        if (!creationMsgKey) {
          continue;
        }
        const pollCreationMsg = getFullMessage(creationMsgKey);
        if (!pollCreationMsg) {
          // poll not in store - skip gracefully
          inboundLogger.warn(
            { creationMsgId: creationMsgKey.id },
            "poll creation msg not in store, skipping vote",
          );
          continue;
        }
        const meIdNormalized = (selfJid ?? "").replace(/:[^@]+/, "");
        // For poll encryption, WhatsApp uses LID JID for the creator when available
        // selfLid is extracted from sock.user (Baileys exposes it via creds)
        const selfLid =
          (sock.user as unknown as { lid?: string })?.lid?.replace(/:[^@]+/, "") ?? null;
        const pollCreatorJid = creationMsgKey?.fromMe
          ? (selfLid ?? meIdNormalized)
          : (creationMsgKey?.participant ?? creationMsgKey?.remoteJid ?? "");
        const voterJid = msg.key?.fromMe
          ? (selfLid ?? meIdNormalized)
          : (msg.key?.participant ?? msg.key?.remoteJid ?? "");
        const pollEncKey = pollCreationMsg.message?.messageContextInfo?.messageSecret;
        console.log("[poll-debug] creationMsgKey=", JSON.stringify(creationMsgKey), "pollCreationMsg.keys=", Object.keys(pollCreationMsg.message ?? {}), "messageSecret=", pollEncKey ? "present" : "MISSING", "pollCreatorJid=", pollCreatorJid, "voterJid=", voterJid);
        if (!pollEncKey) {
          inboundLogger.warn("poll enc key missing, skipping");
          continue;
        }
        let voteMsg;
        try {
          voteMsg = decryptPollVote(pollUpdate.vote!, {
            pollEncKey: Buffer.from(pollEncKey),
            pollCreatorJid,
            pollMsgId: creationMsgKey.id!,
            voterJid,
          });
        } catch (err) {
          inboundLogger.warn({ err }, "poll vote decryption failed (LID bug?), skipping");
          continue;
        }
        // Merge vote into stored message, deduplicate by voter JID
        const existingPollUpdates = pollCreationMsg.pollUpdates ?? [];
        const newVoteEntry = {
          pollUpdateMessageKey: msg.key,
          vote: voteMsg as proto.Message.IPollVoteMessage,
          senderTimestampMs:
            (pollUpdate.senderTimestampMs as number | null | undefined) ?? Date.now(),
        };
        // Replace previous vote from same voter so aggregate is correct
        const dedupedUpdates = existingPollUpdates.filter((u) => {
          const vKey = u.pollUpdateMessageKey;
          const vJid = vKey?.participant ?? vKey?.remoteJid ?? "";
          return vJid !== voterJid;
        });
        const mergedMsg: WAMessage = {
          ...pollCreationMsg,
          pollUpdates: [...dedupedUpdates, newVoteEntry],
        };
        storeMessage(mergedMsg);
        const pollQuestion =
          pollCreationMsg.message?.pollCreationMessage?.name ??
          pollCreationMsg.message?.pollCreationMessageV2?.name ??
          pollCreationMsg.message?.pollCreationMessageV3?.name ??
          "poll";
        if (pollVotesMode === "individual" || pollVotesMode === "both") {
          const selectedOptions =
            voteMsg.selectedOptions?.map((o) => Buffer.from(o).toString("utf8")).join(", ") ?? "?";
          const voterE164 = await resolveInboundJid(voterJid);
          const voterLabel = voterE164 ?? voterJid;
          if (pollVotesMode === "both") {
            // aggregate + who voted
            const aggregated = getAggregateVotesInPollMessage({
              message: mergedMsg.message ?? undefined,
              pollUpdates: mergedMsg.pollUpdates ?? [],
            });
            const summary = aggregated.map((o) => `${o.name}: ${o.voters.length}`).join(", ");
            const voteAction = selectedOptions === "" ? "unvoted" : `voted: ${selectedOptions}`;
            body = `[Poll update: "${pollQuestion}" — ${summary} | ${voterLabel} ${voteAction} | messageId: ${creationMsgKey.id ?? "?"}]`;
          } else {
            body = `[Poll vote: "${pollQuestion}" — ${selectedOptions} (by ${voterLabel})]`;
          }
        } else {
          // aggregate only
          const aggregated = getAggregateVotesInPollMessage({
            message: mergedMsg.message ?? undefined,
            pollUpdates: mergedMsg.pollUpdates ?? [],
          });
          const summary = aggregated.map((o) => `${o.name}: ${o.voters.length}`).join(", ");
          body = `[Poll update: "${pollQuestion}" — ${summary} | messageId: ${creationMsgKey.id ?? "?"}]`;
        }
      }
      if (!body) {
        body = extractMediaPlaceholder(msg.message ?? undefined);
        if (!body) {
          continue;
        }
      }
      const replyContext = describeReplyContext(msg.message as proto.IMessage | undefined);

      let mediaPath: string | undefined;
      let mediaType: string | undefined;
      let mediaFileName: string | undefined;
      try {
        const inboundMedia = await downloadInboundMedia(msg as proto.IWebMessageInfo, sock);
        if (inboundMedia) {
          const maxMb =
            typeof options.mediaMaxMb === "number" && options.mediaMaxMb > 0
              ? options.mediaMaxMb
              : 50;
          const maxBytes = maxMb * 1024 * 1024;
          const saved = await saveMediaBuffer(
            inboundMedia.buffer,
            inboundMedia.mimetype,
            "inbound",
            maxBytes,
            inboundMedia.fileName,
          );
          mediaPath = saved.path;
          mediaType = inboundMedia.mimetype;
          mediaFileName = inboundMedia.fileName;
        }
      } catch (err) {
        logVerbose(`Inbound media download failed: ${String(err)}`);
      }

      const chatJid = remoteJid;
      const sendComposing = async () => {
        try {
          await sock.sendPresenceUpdate("composing", chatJid);
        } catch (err) {
          logVerbose(`Presence update failed: ${String(err)}`);
        }
      };
      const reply = async (text: string) => {
        await sock.sendMessage(chatJid, { text });
      };
      const sendMedia = async (payload: AnyMessageContent) => {
        await sock.sendMessage(chatJid, payload);
      };
      const timestamp = messageTimestampMs;
      const mentionedJids = extractMentionedJids(msg.message as proto.IMessage | undefined);
      const senderName = msg.pushName ?? undefined;

      inboundLogger.info(
        { from, to: selfE164 ?? "me", body, mediaPath, mediaType, mediaFileName, timestamp },
        "inbound message",
      );
      const inboundMessage: WebInboundMessage = {
        id,
        from,
        conversationId: from,
        to: selfE164 ?? "me",
        accountId: access.resolvedAccountId,
        body,
        pushName: senderName,
        timestamp,
        chatType: group ? "group" : "direct",
        chatId: remoteJid,
        senderJid: participantJid,
        senderE164: senderE164 ?? undefined,
        senderName,
        replyToId: replyContext?.id,
        replyToBody: replyContext?.body,
        replyToSender: replyContext?.sender,
        replyToSenderJid: replyContext?.senderJid,
        replyToSenderE164: replyContext?.senderE164,
        groupSubject,
        groupParticipants,
        mentionedJids: mentionedJids ?? undefined,
        selfJid,
        selfE164,
        location: location ?? undefined,
        sendComposing,
        reply,
        sendMedia,
        mediaPath,
        mediaType,
        mediaFileName,
      };
      try {
        const task = Promise.resolve(debouncer.enqueue(inboundMessage));
        void task.catch((err) => {
          inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
          inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
        });
      } catch (err) {
        inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
        inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
      }
    }
  };
  sock.ev.on("messages.upsert", handleMessagesUpsert);

  // Handle pin/unpin events arriving as messages.update (e.g. DM pins)
  type WAMessageUpdate = {
    key: import("@whiskeysockets/baileys").WAMessageKey;
    update: Partial<import("@whiskeysockets/baileys").WAMessage>;
  };
  const handleMessagesUpdate = async (updates: WAMessageUpdate[]) => {
    const cfg = loadConfig();
    const pinsEnabled = cfg?.channels?.whatsapp?.inbound?.pins === true;
    if (!pinsEnabled) {
      return;
    }
    for (const { key, update } of updates) {
      const pinInChat = (update.message as Record<string, unknown> | null | undefined)
        ?.pinInChatMessage as
        | import("@whiskeysockets/baileys").proto.Message.IPinInChatMessage
        | null
        | undefined;
      if (!pinInChat) {
        continue;
      }
      const remoteJid = key.remoteJid;
      if (!remoteJid) {
        continue;
      }
      if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
        continue;
      }
      const pinnedMsgId = pinInChat.key?.id ?? "unknown";
      const pinType = Number(pinInChat.type);
      const body =
        pinType === 2 ? `[Unpinned message ${pinnedMsgId}]` : `[Pinned message ${pinnedMsgId}]`;
      const from = isJidGroup(remoteJid)
        ? remoteJid
        : ((await resolveInboundJid(remoteJid)) ?? remoteJid);
      try {
        await options.onMessage({
          id: key.id ?? "pin-event",
          from,
          conversationId: remoteJid,
          to: selfE164 ?? "",
          body,
          timestamp: Date.now(),
          chatType: isJidGroup(remoteJid) ? "group" : "direct",
          chatId: isJidGroup(remoteJid) ? `group:${remoteJid}` : `direct:${from}`,
          accountId: options.accountId,
          sendComposing: async () => {},
          reply: async (text) => {
            await sock.sendMessage(remoteJid, { text });
          },
          sendMedia: async () => {},
        });
      } catch (err) {
        inboundLogger.error({ error: String(err) }, "failed handling pin update");
      }
    }
  };
  sock.ev.on("messages.update", handleMessagesUpdate as (updates: unknown[]) => void);

  const handleConnectionUpdate = (
    update: Partial<import("@whiskeysockets/baileys").ConnectionState>,
  ) => {
    try {
      if (update.connection === "close") {
        const status = getStatusCode(update.lastDisconnect?.error);
        resolveClose({
          status,
          isLoggedOut: status === DisconnectReason.loggedOut,
          error: update.lastDisconnect?.error,
        });
      }
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "connection.update handler error");
      resolveClose({ status: undefined, isLoggedOut: false, error: err });
    }
  };
  sock.ev.on("connection.update", handleConnectionUpdate);

  const sendApi = createWebSendApi({
    sock: {
      sendMessage: (jid: string, content: AnyMessageContent) => sock.sendMessage(jid, content),
      sendPresenceUpdate: (presence, jid?: string) => sock.sendPresenceUpdate(presence, jid),
      updateProfilePicture: (
        sock as unknown as {
          updateProfilePicture?: (jid: string, content: Buffer) => Promise<void>;
        }
      ).updateProfilePicture
        ? (jid: string, content: Buffer) =>
            (
              sock as unknown as {
                updateProfilePicture: (jid: string, content: Buffer) => Promise<void>;
              }
            ).updateProfilePicture(jid, content)
        : undefined,
      user: (sock as unknown as { user?: { id: string } }).user,
      groupMetadata: (jid: string) => sock.groupMetadata(jid),
    },
    defaultAccountId: options.accountId,
    getFullMessage: getFullMessage,
    storeMessage: storeMessage,
    removeProfilePictureFn: (
      sock as unknown as { removeProfilePicture?: (jid: string) => Promise<void> }
    ).removeProfilePicture
      ? () => {
          const rawId = (sock as unknown as { user?: { id: string } }).user?.id ?? "";
          const myJid = rawId.replace(/:[^@]+@/, "@");
          return (
            sock as unknown as { removeProfilePicture: (jid: string) => Promise<void> }
          ).removeProfilePicture(myJid);
        }
      : undefined,
  });

  return {
    close: async () => {
      try {
        const ev = sock.ev as unknown as {
          off?: (event: string, listener: (...args: unknown[]) => void) => void;
          removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
        };
        const messagesUpsertHandler = handleMessagesUpsert as unknown as (
          ...args: unknown[]
        ) => void;
        const connectionUpdateHandler = handleConnectionUpdate as unknown as (
          ...args: unknown[]
        ) => void;
        if (typeof ev.off === "function") {
          ev.off("messages.upsert", messagesUpsertHandler);
          ev.off("connection.update", connectionUpdateHandler);
        } else if (typeof ev.removeListener === "function") {
          ev.removeListener("messages.upsert", messagesUpsertHandler);
          ev.removeListener("connection.update", connectionUpdateHandler);
        }
        sock.ws?.close();
      } catch (err) {
        logVerbose(`Socket close failed: ${String(err)}`);
      }
    },
    onClose,
    signalClose: (reason?: WebListenerCloseReason) => {
      resolveClose(reason ?? { status: undefined, isLoggedOut: false, error: "closed" });
    },
    // IPC surface (sendMessage/sendPoll/sendReaction/sendComposingTo)
    ...sendApi,
  } as const;
}

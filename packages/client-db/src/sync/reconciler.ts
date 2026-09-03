import { LocalDatabase } from "../database.js";
import { Message } from "../models/Message.js";
import { Channel } from "../models/Channel.js";

export interface InboundEncryptedPayload {
  channel_id: string;
  sender_id: string;
  message_id: string;
  sequence_num: number;
  ciphertext_base64: string;
  message_type: number; // 0 = PreKey, 1 = Normal
  session_pickle: string;
  pickle_key_hex: string;
  timestamp?: number;
}

export interface CryptoDecryptor {
  decryptMessage(
    sessionPickle: string,
    pickleKeyHex: string,
    messageType: number,
    ciphertextBase64: string
  ): { plaintext: Uint8Array; updated_session_pickle: string };
}

export class InboundSyncReconciler {
  private db: LocalDatabase;
  private crypto: CryptoDecryptor;
  private queue: InboundEncryptedPayload[] = [];
  private isProcessing = false;
  private batchIntervalMs: number;
  private batchTimer: NodeJS.Timeout | null = null;

  constructor(db: LocalDatabase, crypto: CryptoDecryptor, batchIntervalMs: number = 25) {
    this.db = db;
    this.crypto = crypto;
    this.batchIntervalMs = batchIntervalMs;
  }

  /**
   * Enqueue an incoming encrypted message from the WebSocket gateway
   */
  public enqueue(payload: InboundEncryptedPayload): void {
    this.queue.push(payload);
    this.scheduleBatch();
  }

  private scheduleBatch(): void {
    if (this.batchTimer || this.isProcessing) return;

    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flushQueue();
    }, this.batchIntervalMs);
  }

  /**
   * Process all queued messages in a single atomic database batch
   */
  public async flushQueue(): Promise<number> {
    if (this.queue.length === 0 || this.isProcessing) return 0;

    this.isProcessing = true;
    const batch = this.queue.splice(0, this.queue.length);

    try {
      await this.db.write(async () => {
        for (const item of batch) {
          // 1. Offload Double Ratchet decryption to Wasm
          let plaintextString = "";
          try {
            const decResult = this.crypto.decryptMessage(
              item.session_pickle,
              item.pickle_key_hex,
              item.message_type,
              item.ciphertext_base64
            );
            plaintextString = new TextDecoder().decode(decResult.plaintext);
          } catch (decErr) {
            console.error(`[InboundSyncReconciler] Decryption failed for message ${item.message_id}:`, decErr);
            plaintextString = "[Decryption Failed]";
          }

          // 2. Insert or update local message
          const msgCol = this.db.get("messages");
          await msgCol.create((record: Message) => {
            record.id = item.message_id;
            record.channelId = item.channel_id;
            record.senderId = item.sender_id;
            record.clientMsgId = item.message_id;
            record.sequenceNum = item.sequence_num;
            record.text = plaintextString;
            record.status = "delivered";
            record.messageType = "text";
            record.createdAt = item.timestamp ? new Date(item.timestamp) : new Date();
          });

          // 3. Update channel activity and increment unread count
          const channelCol = this.db.get("channels");
          const channel = await channelCol.find(item.channel_id);
          if (channel) {
            await channel.update((c: Channel) => {
              c.lastMessageAt = new Date();
              c.unreadCount = (c.unreadCount || 0) + 1;
            });
          }
        }
      });

      return batch.length;
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0) {
        this.scheduleBatch();
      }
    }
  }
}

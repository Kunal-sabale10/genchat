import { LocalDatabase } from "../database";
import { Message, MessageStatus } from "../models/Message";

export interface GatewayAck {
  client_msg_id: string;
  message_id: string;
  sequence_num: number;
}

export interface CryptoEncryptor {
  encryptMessage(
    sessionPickle: string,
    pickleKeyHex: string,
    plaintext: string | Uint8Array
  ): { message_type: number; ciphertext_base64: string; updated_session_pickle: string };
}

export interface WebSocketTransport {
  send(payload: any): Promise<GatewayAck>;
}

export class OptimisticOutbox {
  private db: LocalDatabase;
  private crypto: CryptoEncryptor;
  private transport: WebSocketTransport;

  constructor(db: LocalDatabase, crypto: CryptoEncryptor, transport: WebSocketTransport) {
    this.db = db;
    this.crypto = crypto;
    this.transport = transport;
  }

  /**
   * 1. Immediate optimistic send:
   * Writes record with status: 'pending' so UI renders instantly,
   * then encrypts and transmits asynchronously in background.
   */
  public async send(
    channelId: string,
    senderId: string,
    plaintext: string,
    sessionPickle: string,
    pickleKeyHex: string
  ): Promise<Message> {
    const clientMsgId = "msg_" + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    const messagesCol = this.db.get("messages");

    // 1. Optimistic insert: status is pending
    const localRecord = await messagesCol.create((msg: Message) => {
      msg.id = clientMsgId;
      msg.channelId = channelId;
      msg.senderId = senderId;
      msg.clientMsgId = clientMsgId;
      msg.text = plaintext;
      msg.status = "pending";
      msg.messageType = "text";
      msg.createdAt = new Date();
    });

    // 2. Asynchronous background delivery
    this.dispatchInBackground(localRecord, plaintext, sessionPickle, pickleKeyHex).catch((err) => {
      console.error(`[OptimisticOutbox] Delivery failed for ${clientMsgId}:`, err);
    });

    return localRecord;
  }

  private async dispatchInBackground(
    record: Message,
    plaintext: string,
    sessionPickle: string,
    pickleKeyHex: string
  ): Promise<void> {
    try {
      // 1. Encrypt via Wasm
      const encResult = this.crypto.encryptMessage(sessionPickle, pickleKeyHex, plaintext);

      // 2. Send over WebSocket to gatewayd
      const wirePayload = {
        action: "send_message",
        channel_id: record.channelId,
        client_msg_id: record.clientMsgId,
        ciphertext_base64: encResult.ciphertext_base64,
        message_type: encResult.message_type,
      };

      const ack = await this.transport.send(wirePayload);

      // 3. Reconcile local state: update status to 'sent' and attach server sequence_num
      await record.update((m: Message) => {
        m.status = "sent";
        m.sequenceNum = ack.sequence_num;
      });
    } catch (err) {
      // Mark failed for retry
      await record.update((m: Message) => {
        m.status = "failed";
      });
      throw err;
    }
  }

  /**
   * Manually reconcile when an asynchronous server ACK arrives
   */
  public async reconcileAck(ack: GatewayAck): Promise<void> {
    const messagesCol = this.db.get("messages");
    const matches = await messagesCol.query({ client_msg_id: ack.client_msg_id });

    if (matches.length > 0) {
      const msg = matches[0];
      await msg.update((m: Message) => {
        m.status = "sent";
        m.sequenceNum = ack.sequence_num;
      });
    }
  }
}

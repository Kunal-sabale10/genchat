import { Database } from '@nozbe/watermelondb'
import { GenChatCrypto } from '@genchat/client-crypto'
import { Message, Channel } from './models'

export class SyncReconciler {
  constructor(
    private db: Database, 
    private crypto: GenChatCrypto
  ) {}

  /**
   * Handles incoming encrypted push payloads from gatewayd
   */
  async handleIncomingPush(payload: { channelId: string; senderId: string; ciphertext: string; messageType: number; serverId: string }) {
    // 1. Fetch the ratchet session for this channel from SecureKeyStorage
    const sessionPickle = await this.crypto.storage.getSession(payload.channelId)

    // 2. Decrypt the message via the Rust WebAssembly engine
    const decrypted = await this.crypto.decryptMessage(
      sessionPickle, 
      payload.messageType, 
      payload.ciphertext
    )

    // 3. Save updated session state back to SecureKeyStorage (Ratchet advanced)
    await this.crypto.storage.saveSession(payload.channelId, decrypted.updated_session_pickle)

    // 4. Batch write to WatermelonDB (UI updates instantly)
    await this.db.write(async () => {
      await this.db.collections.get<Message>('messages').create(record => {
        record.serverId = payload.serverId
        ;(record as any)._raw.channel_id = payload.channelId
        record.senderId = payload.senderId
        // Convert decrypted byte array back to string
        record.body = new TextDecoder().decode(decrypted.plaintext)
        record.status = 'delivered'
      })
    })
  }
}

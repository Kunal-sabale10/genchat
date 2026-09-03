import { Database } from '@nozbe/watermelondb'
import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs'
import { mySchema } from '../src/schema'
import { Channel, Message } from '../src/models'
import { SyncReconciler } from '../src/sync'
import { GenChatCrypto } from '@genchat/client-crypto'

describe('WebSocket Sync Reconciler', () => {
  let database: Database
  let mockCrypto: any

  beforeAll(() => {
    const adapter = new LokiJSAdapter({
      schema: mySchema,
      useWebWorker: false,
      useIncrementalIndexedDB: false,
    })

    database = new Database({
      adapter,
      modelClasses: [Channel, Message],
    })

    // Mock GenChatCrypto with storage and Wasm engine
    const sessions = new Map<string, string>()
    mockCrypto = {
      storage: {
        getSession: async (channelId: string) => sessions.get(channelId) || 'initial_pickle',
        saveSession: async (channelId: string, pickle: string) => {
          sessions.set(channelId, pickle)
        },
      },
      decryptMessage: async (pickle: string, msgType: number, ct: string) => {
        return {
          plaintext: new TextEncoder().encode('Decrypted: ' + ct),
          updated_session_pickle: pickle + '_advanced',
        }
      },
    }
  })

  afterAll(async () => {
    await database.write(() => database.unsafeResetDatabase())
  })

  it('receives encrypted push, decrypts via Wasm, updates session, and writes delivered message to WatermelonDB', async () => {
    const reconciler = new SyncReconciler(database, mockCrypto as GenChatCrypto)

    // 1. Inbound push arrives from gatewayd
    await reconciler.handleIncomingPush({
      channelId: 'chan_secret_room',
      senderId: 'alice',
      ciphertext: 'quantum_safe_payload',
      messageType: 1,
      serverId: 'srv_msg_555',
    })

    // 2. Verify message was written to WatermelonDB
    const messages = await database.collections.get<Message>('messages').query().fetch()
    expect(messages.length).toBe(1)
    expect(messages[0].serverId).toBe('srv_msg_555')
    expect(messages[0].senderId).toBe('alice')
    expect(messages[0].body).toBe('Decrypted: quantum_safe_payload')
    expect(messages[0].status).toBe('delivered')

    // 3. Verify ratchet session was advanced and saved
    const advancedSession = await mockCrypto.storage.getSession('chan_secret_room')
    expect(advancedSession).toBe('initial_pickle_advanced')
  })
})

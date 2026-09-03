import { Database } from '@nozbe/watermelondb'
import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs'
import { mySchema } from '../src/schema'
import { Channel, Message } from '../src/models'

describe('Local-First Data Layer (Phase 6)', () => {
  let database: Database

  beforeAll(() => {
    // Spin up an in-memory database using LokiJS for Node testing
    const adapter = new LokiJSAdapter({
      schema: mySchema,
      useWebWorker: false,
      useIncrementalIndexedDB: false,
    })

    database = new Database({
      adapter,
      modelClasses: [Channel, Message],
    })
  })

  afterAll(async () => {
    await database.write(() => database.unsafeResetDatabase())
  })

  it('optimistically writes a pending message and updates on server ACK', async () => {
    // 1. Create a Channel
    const channel = await database.write(async () => {
      return await database.collections.get<Channel>('channels').create(record => {
        record.serverId = 'chan_123'
        record.name = 'Project PQXDH'
        record.type = 'group'
      })
    })

    expect(channel.name).toBe('Project PQXDH')

    // 2. The Optimistic Outbox: Insert a pending message instantly
    const message = await database.write(async () => {
      return await database.collections.get<Message>('messages').create(record => {
        record.channelId = channel.id
        record.senderId = 'me'
        record.body = 'Hello, encrypted world!'
        record.status = 'pending' // Zero-latency UI assumption
      })
    })

    expect(message.status).toBe('pending')

    // 3. Verify relations (Channel now has 1 message)
    const channelMessages = await database.collections.get<Message>('messages').query().fetch()
    expect(channelMessages.length).toBe(1)
    expect(channelMessages[0].body).toBe('Hello, encrypted world!')

    // 4. Simulate the WebSocket Reconciler receiving a success ACK from gatewayd
    await database.write(async () => {
      await message.update(record => {
        record.status = 'sent'
        record.serverId = 'msg_987'
      })
    })

    // 5. Verify the state was mutated reactively
    const updatedMessage = await database.collections.get<Message>('messages').find(message.id)
    expect(updatedMessage.status).toBe('sent')
    expect(updatedMessage.serverId).toBe('msg_987')
  })
})

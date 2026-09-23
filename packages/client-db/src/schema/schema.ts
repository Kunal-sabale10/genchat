import { appSchema, tableSchema } from '@nozbe/watermelondb';

export const mySchema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'channels',
      columns: [
        { name: 'name', type: 'string' },
        { name: 'is_group', type: 'boolean' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'messages',
      columns: [
        { name: 'channel_id', type: 'string', isIndexed: true },
        { name: 'sender_id', type: 'string' },
        { name: 'ciphertext', type: 'string' },
        { name: 'nonce', type: 'string' },
        { name: 'created_at', type: 'number' },
        { name: 'status', type: 'string' },
      ],
    }),
  ],
});

export default mySchema;
export { mySchema as appSchema };

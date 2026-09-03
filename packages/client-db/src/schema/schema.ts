export interface ColumnSchema {
  name: string;
  type: "string" | "number" | "boolean";
  isOptional?: boolean;
  isIndexed?: boolean;
}

export interface TableSchema {
  name: string;
  columns: Record<string, ColumnSchema>;
}

export interface AppSchema {
  version: number;
  tables: Record<string, TableSchema>;
}

export const appSchema: AppSchema = {
  version: 1,
  tables: {
    channels: {
      name: "channels",
      columns: {
        name: { name: "name", type: "string" },
        channel_type: { name: "channel_type", type: "string", isIndexed: true }, // 'direct' | 'group'
        last_message_at: { name: "last_message_at", type: "number", isIndexed: true },
        unread_count: { name: "unread_count", type: "number" },
        created_at: { name: "created_at", type: "number" },
        updated_at: { name: "updated_at", type: "number" },
      },
    },
    messages: {
      name: "messages",
      columns: {
        channel_id: { name: "channel_id", type: "string", isIndexed: true },
        sender_id: { name: "sender_id", type: "string", isIndexed: true },
        client_msg_id: { name: "client_msg_id", type: "string", isIndexed: true },
        sequence_num: { name: "sequence_num", type: "number", isOptional: true, isIndexed: true },
        text: { name: "text", type: "string" },
        status: { name: "status", type: "string", isIndexed: true }, // 'pending' | 'sent' | 'delivered' | 'read' | 'failed'
        message_type: { name: "message_type", type: "string" }, // 'text' | 'media' | 'call'
        media_id: { name: "media_id", type: "string", isOptional: true, isIndexed: true },
        created_at: { name: "created_at", type: "number", isIndexed: true },
      },
    },
    media_metadata: {
      name: "media_metadata",
      columns: {
        message_id: { name: "message_id", type: "string", isIndexed: true },
        object_key: { name: "object_key", type: "string", isIndexed: true },
        encryption_key_hex: { name: "encryption_key_hex", type: "string" },
        iv_hex: { name: "iv_hex", type: "string" },
        mime_type: { name: "mime_type", type: "string" },
        file_size: { name: "file_size", type: "number" },
        thumbnail_base64: { name: "thumbnail_base64", type: "string", isOptional: true },
        created_at: { name: "created_at", type: "number" },
      },
    },
  },
};

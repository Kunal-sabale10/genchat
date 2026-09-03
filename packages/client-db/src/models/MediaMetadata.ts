import { Model, field, date, relation } from "./decorators.js";
import { Message } from "./Message.js";

export class MediaMetadata extends Model {
  public static table = "media_metadata";

  @field("message_id")
  public messageId!: string;

  @field("object_key")
  public objectKey!: string;

  @field("encryption_key_hex")
  public encryptionKeyHex!: string;

  @field("iv_hex")
  public ivHex!: string;

  @field("mime_type")
  public mimeType!: string;

  @field("file_size")
  public fileSize!: number;

  @field("thumbnail_base64")
  public thumbnailBase64?: string;

  @date("created_at")
  public createdAt!: Date;

  @relation("messages", "message_id")
  public message!: {
    fetch: () => Promise<Message | null>;
  };
}

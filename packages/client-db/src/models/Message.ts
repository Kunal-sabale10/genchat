import { Model, field, text, date, relation } from "./decorators.js";
import { Channel } from "./Channel.js";
import { MediaMetadata } from "./MediaMetadata.js";

export type MessageStatus = "pending" | "sent" | "delivered" | "read" | "failed";

export class Message extends Model {
  public static table = "messages";

  @field("channel_id")
  public channelId!: string;

  @field("sender_id")
  public senderId!: string;

  @field("client_msg_id")
  public clientMsgId!: string;

  @field("sequence_num")
  public sequenceNum?: number;

  @text("text")
  public text!: string;

  @field("status")
  public status!: MessageStatus;

  @field("message_type")
  public messageType!: "text" | "media" | "call";

  @field("media_id")
  public mediaId?: string;

  @date("created_at")
  public createdAt!: Date;

  @relation("channels", "channel_id")
  public channel!: {
    fetch: () => Promise<Channel | null>;
  };

  @relation("media_metadata", "media_id")
  public media!: {
    fetch: () => Promise<MediaMetadata | null>;
  };
}

import { Model, field, date, children } from "./decorators.js";
import { Message } from "./Message.js";

export class Channel extends Model {
  public static table = "channels";

  @field("name")
  public name!: string;

  @field("channel_type")
  public channelType!: "direct" | "group";

  @date("last_message_at")
  public lastMessageAt!: Date | null;

  @field("unread_count")
  public unreadCount!: number;

  @date("created_at")
  public createdAt!: Date;

  @date("updated_at")
  public updatedAt!: Date;

  @children("messages")
  public messages!: {
    fetch: () => Promise<Message[]>;
  };
}

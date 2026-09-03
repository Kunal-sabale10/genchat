import { Model } from '@nozbe/watermelondb'
import { field, date, relation, children } from '@nozbe/watermelondb/decorators'
import { Associations } from '@nozbe/watermelondb/Model'

export class Channel extends Model {
  static table = 'channels'
  static associations: Associations = {
    messages: { type: 'has_many', foreignKey: 'channel_id' },
  }

  @field('server_id') serverId!: string
  @field('name') name!: string
  @field('type') type!: string
  @field('last_message_text') lastMessageText?: string
  @date('updated_at') updatedAt!: number

  @children('messages') messages!: any
}

export class Message extends Model {
  static table = 'messages'
  static associations: Associations = {
    channels: { type: 'belongs_to', key: 'channel_id' },
  }

  @field('server_id') serverId?: string
  @field('channel_id') channelId!: string
  @relation('channels', 'channel_id') channel!: any
  @field('sender_id') senderId!: string
  @field('body') body!: string
  @field('status') status!: string 
  @date('created_at') createdAt!: number
}

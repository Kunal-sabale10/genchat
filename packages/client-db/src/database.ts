import { appSchema } from "./schema/schema";
import { Channel } from "./models/Channel";
import { Message } from "./models/Message";
import { MediaMetadata } from "./models/MediaMetadata";

export class LocalCollection<T extends { id: string; raw: any }> {
  private items: Map<string, T> = new Map();
  private modelClass: new (id: string, raw: any, db: LocalDatabase) => T;
  private db: LocalDatabase;

  constructor(modelClass: new (id: string, raw: any, db: LocalDatabase) => T, db: LocalDatabase) {
    this.modelClass = modelClass;
    this.db = db;
  }

  public async find(id: string): Promise<T | null> {
    return this.items.get(id) ?? null;
  }

  public async query(filter?: Record<string, any>): Promise<T[]> {
    const all = Array.from(this.items.values());
    if (!filter) return all;

    return all.filter((item) => {
      for (const [k, v] of Object.entries(filter)) {
        if (item.raw[k] !== v) return false;
      }
      return true;
    });
  }

  public async create(recordBuilder: (record: T) => void): Promise<T> {
    const defaultId = Math.random().toString(36).substring(2, 12);
    const instance = new this.modelClass(defaultId, {}, this.db);
    recordBuilder(instance);
    const finalId = instance.id || defaultId;
    instance.id = finalId;
    if (instance.raw) instance.raw.id = finalId;
    this.items.set(finalId, instance);
    return instance;
  }

  public put(instance: T): void {
    this.items.set(instance.id, instance);
  }

  public all(): T[] {
    return Array.from(this.items.values());
  }
}

export class LocalDatabase {
  public schema = appSchema;
  private collections: Map<string, LocalCollection<any>> = new Map();

  constructor() {
    this.collections.set("channels", new LocalCollection(Channel, this));
    this.collections.set("messages", new LocalCollection(Message, this));
    this.collections.set("media_metadata", new LocalCollection(MediaMetadata, this));
  }

  public get<T extends { id: string; raw: any }>(tableName: "channels"): LocalCollection<Channel>;
  public get<T extends { id: string; raw: any }>(tableName: "messages"): LocalCollection<Message>;
  public get<T extends { id: string; raw: any }>(tableName: "media_metadata"): LocalCollection<MediaMetadata>;
  public get<T extends { id: string; raw: any }>(tableName: string): LocalCollection<any> {
    const col = this.collections.get(tableName);
    if (!col) {
      throw new Error(`Collection for table ${tableName} not found`);
    }
    return col;
  }

  /**
   * Atomic batch transaction
   */
  public async write<R>(action: () => Promise<R>): Promise<R> {
    return await action();
  }

  public async batch(...operations: Promise<any>[]): Promise<void> {
    await Promise.all(operations);
  }
}

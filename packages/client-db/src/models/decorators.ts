import { Model as WatermelonModel } from "@nozbe/watermelondb";

// Decorator helpers compatible with WatermelonDB model conventions
export function field(columnName: string) {
  return function (target: any, propertyKey: string) {
    const privateKey = `_${propertyKey}`;
    Object.defineProperty(target, propertyKey, {
      get() {
        return this[privateKey] ?? this._raw?.[columnName] ?? this.raw?.[columnName];
      },
      set(val: any) {
        this[privateKey] = val;
        if (this._raw) {
          this._raw[columnName] = val;
        }
        if (this.raw) {
          this.raw[columnName] = val;
        }
      },
      enumerable: true,
      configurable: true,
    });
  };
}

export function date(columnName: string) {
  return function (target: any, propertyKey: string) {
    const privateKey = `_${propertyKey}`;
    Object.defineProperty(target, propertyKey, {
      get() {
        const val = this[privateKey] ?? this._raw?.[columnName] ?? this.raw?.[columnName];
        return val ? new Date(val) : null;
      },
      set(val: Date | number | null) {
        const ms = val instanceof Date ? val.getTime() : val;
        this[privateKey] = ms;
        if (this._raw) {
          this._raw[columnName] = ms;
        }
        if (this.raw) {
          this.raw[columnName] = ms;
        }
      },
      enumerable: true,
      configurable: true,
    });
  };
}

export function text(columnName: string) {
  return field(columnName);
}

export function relation(tableName: string, foreignKey: string) {
  return function (target: any, propertyKey: string) {
    Object.defineProperty(target, propertyKey, {
      get() {
        const fk = this._raw?.[foreignKey] ?? this.raw?.[foreignKey];
        return {
          id: fk,
          table: tableName,
          fetch: async () => {
            if (!this.database || !fk) return null;
            return this.database.get(tableName).find(fk);
          },
        };
      },
      enumerable: true,
      configurable: true,
    });
  };
}

export function children(tableName: string) {
  return function (target: any, propertyKey: string) {
    Object.defineProperty(target, propertyKey, {
      get() {
        return {
          table: tableName,
          fetch: async () => {
            if (!this.database) return [];
            return this.database.get(tableName).query({ channel_id: this.id });
          },
        };
      },
      enumerable: true,
      configurable: true,
    });
  };
}

export class Model extends WatermelonModel {
  [key: string]: any;

  constructor(collection?: any, raw?: any) {
    super(collection, raw || {});
    return new Proxy(this, {
      get(target: any, prop: string | symbol) {
        if (prop in target) {
          return target[prop];
        }
        if (typeof prop === "string" && target._raw && prop in target._raw) {
          return target._raw[prop];
        }
        return undefined;
      },
      set(target: any, prop: string | symbol, value: any) {
        if (typeof prop === "string") {
          if (!target._raw) {
            target._raw = {};
          }
          target._raw[prop] = value;
        }
        if (prop === "id") {
          return true;
        }
        try {
          target[prop] = value;
        } catch {
          // ignore read-only or getter-only properties
        }
        return true;
      },
    });
  }

  public get raw(): Record<string, any> {
    return (this as any)._raw || {};
  }

  public set raw(val: Record<string, any>) {
    (this as any)._raw = val;
  }

  public async update(recordUpdater: (record: this) => void): Promise<this> {
    if (
      this.collection &&
      this.collection.database &&
      typeof this.collection.database._ensureInWriter === "function"
    ) {
      return await super.update(recordUpdater as any);
    }
    recordUpdater(this);
    return this;
  }
}


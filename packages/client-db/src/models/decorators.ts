// Decorator helpers compatible with WatermelonDB model conventions
export function field(columnName: string) {
  return function (target: any, propertyKey: string) {
    const privateKey = `_${propertyKey}`;
    Object.defineProperty(target, propertyKey, {
      get() {
        return this[privateKey] ?? this.raw?.[columnName];
      },
      set(val: any) {
        this[privateKey] = val;
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
        const val = this[privateKey] ?? this.raw?.[columnName];
        return val ? new Date(val) : null;
      },
      set(val: Date | number | null) {
        const ms = val instanceof Date ? val.getTime() : val;
        this[privateKey] = ms;
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
        const fk = this.raw?.[foreignKey];
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

export class Model {
  public id: string = "";
  public raw: Record<string, any> = {};
  public database: any = null;

  constructor(id: string, raw: Record<string, any> = {}, database?: any) {
    this.id = id;
    this.raw = { ...raw, id };
    this.database = database;
  }

  public async update(recordUpdater: (record: this) => void): Promise<this> {
    recordUpdater(this);
    return this;
  }
}

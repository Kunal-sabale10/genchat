declare module '@nozbe/watermelondb' {
  export function appSchema(options: any): any;
  export function tableSchema(options: any): any;
  export class Database {
    constructor(options?: any);
    collections: any;
    write(action: () => Promise<any>): Promise<any>;
    batch(...operations: any[]): Promise<any>;
  }
  export class Model {
    constructor(collection?: any, raw?: any);
    id: string;
    _raw: any;
    table: string;
    database: any;
    collection: any;
    static _prepareCreate: any;
    update(recordUpdater: (record: any) => void): Promise<any>;
  }
}

declare module '@nozbe/watermelondb/decorators' {
  export function field(columnName: string): any;
  export function date(columnName: string): any;
  export function text(columnName: string): any;
  export function relation(tableName: string, foreignKey: string): any;
  export function children(tableName: string): any;
}

declare module '@nozbe/watermelondb/Model' {
  export interface Associations {
    [key: string]: any;
  }
}

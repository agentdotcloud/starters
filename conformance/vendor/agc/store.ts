// A stand-in for agent-cloud's control store.ts. github.ts imports only these types, and the conformance suite uses
// nothing from github.ts but secretIn, so the stand-in only has to type-check, never run.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AppRow = any;
export interface Store {
  q<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
  op(id: string): Promise<any>;
  app(name: string): Promise<any>;
  snapshot(id: string): Promise<Buffer | undefined>;
  releases(app: string, limit?: number): Promise<any[]>;
  event(...args: any[]): Promise<void>;
}

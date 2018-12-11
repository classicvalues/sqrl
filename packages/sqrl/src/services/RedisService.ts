/**
 * Copyright 2018 Twitter, Inc.
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
import { addressToHostPort } from "../jslib/addressToHostPort";
import * as Redis from "ioredis";
import invariant from "../jslib/invariant";
import murmurhash = require("murmurhash-native");
import { Context, DatabaseSet } from "../api/ctx";

export interface RateLimitOptions {
  maxAmount: number;
  refillTimeMs: number;
  refillAmount: number;
  take: number;
  at: number;
  strict: boolean;
}

export interface RedisInterface {
  rateLimitFetch(
    ctx: Context,
    key: Buffer,
    opt: RateLimitOptions
  ): Promise<number>;
  increment(ctx: Context, key: Buffer, amount?: number): Promise<number>;
  get(ctx: Context, key: Buffer): Promise<Buffer>;
  del(ctx: Context, ...keys: Buffer[]): Promise<number>;
  set(
    ctx: Context,
    key: Buffer,
    value: string,
    mode?: "NX" | "XX"
  ): Promise<boolean>;
  getList(ctx: Context, key: Buffer): Promise<string[]>;
  listPush(
    ctx: Context,
    key: Buffer,
    ...values: Array<string | Buffer | number>
  ): Promise<void>;
  pfcount(ctx: Context, keys: Buffer[]): Promise<number>;
  pfadd(ctx: Context, key: Buffer, values: string[]): Promise<void>;
  expire(ctx: Context, key: Buffer, seconds: number): Promise<void>;
  mgetNumbers(ctx: Context, keys: Buffer[]): Promise<number[]>;
}

export function redisKey(
  databaseSet: DatabaseSet,
  prefix: string,
  ...keys: Array<string | number | Buffer>
): Buffer {
  // Use murmurhash to compress the key
  // @NOTE: This method could do with a huge amount of improvements in the
  // future for things such as sharding, non-binary keys, much faster, etc...
  // but for now this is a /good enough/ solution to the problem.
  const parts = [
    databaseSet.getDatasetId(),
    prefix,
    ...keys.map(key => {
      if (key instanceof Buffer) {
        return key.toString("hex");
      } else {
        return key;
      }
    })
  ];
  return murmurhash.murmurHash128x64(
    Buffer.from(JSON.stringify(parts), "utf-8"),
    0,
    "buffer"
  );
}

export class RedisService implements RedisInterface {
  // @TODO: IoRedis types are not great. We need to improve them but for now we
  // just use the any type.
  private conn: any;

  constructor(address?: string) {
    const [host, port] = addressToHostPort(address || "localhost", 6379);
    this.conn = new Redis({ host, port });
  }

  async ping(ctx: Context) {
    return this.conn.ping();
  }
  async increment(ctx: Context, key: Buffer, amount: number = null) {
    return this.conn.incrby(key, amount == null ? 1 : amount);
  }
  async get(ctx: Context, key: Buffer) {
    return this.conn.get(key);
  }
  async del(ctx: Context, ...keys: Buffer[]) {
    return this.conn.del(...keys);
  }
  async set(ctx: Context, key: Buffer, value: string, mode?: "NX" | "XX") {
    const args = mode ? [mode] : [];
    const rv = await this.conn.set(key, value, ...args);
    if (rv === "OK") {
      return true;
    } else if (rv === null) {
      return false;
    } else {
      throw new Error("Unknown response from Redis set: " + rv);
    }
  }
  async getList(ctx: Context, key: Buffer): Promise<string[]> {
    return this.conn.lrange(key, 0, -1);
  }
  async listPush(
    ctx: Context,
    key: Buffer,
    ...values: Array<string | Buffer | number>
  ): Promise<void> {
    await this.conn.lpush(key, ...values);
  }

  async pfcount(ctx: Context, keys: Buffer[]): Promise<number> {
    return this.conn.pfcount(...keys);
  }

  async pfadd(ctx: Context, key: Buffer, values: string[]): Promise<void> {
    await this.conn.pfaddBuffer(key, ...values);
  }

  async expire(ctx: Context, key: Buffer, seconds: number): Promise<void> {
    await this.conn.expire(key, seconds);
  }

  async mgetNumbers(ctx: Context, keys: Buffer[]): Promise<number[]> {
    return this.conn.mget(...keys).map(value => {
      if (value === null) {
        return value;
      }
      const rv = parseInt(value, 10);
      invariant(!isNaN(rv), "Got invalid number in mgetNumbers");
      return rv;
    });
  }

  async rateLimitFetch(
    ctx: Context,
    key: Buffer,
    opt: RateLimitOptions
  ): Promise<number> {
    const LUA = `
    local current = redis.call("get", KEYS[1]);
    local remaining
    local next
    if current ~= nil then
      remaining = ARGV[1]
      next = ARGV[2]
    else
      remaining, next = struct.unpack("i8i8", current)
    end

    remaining = remaining - 1

    redis.call("set", KEYS[1], struct.pack(
      "i8i8", remaining, next
    ))
    return remaining
    `;
    return this.conn.eval(LUA, 1, key, opt.maxAmount, opt.at);
  }

  close() {
    this.conn.disconnect();
  }
}
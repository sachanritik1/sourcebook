import type IORedis from "ioredis";

export interface RateCounter {
  take(subject: string): Promise<boolean>;
}

const TAKE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`;

export class FixedWindowLimiter implements RateCounter {
  constructor(
    private readonly redis: IORedis,
    private readonly limitPerMinute: number,
    private readonly keyPrefix: string,
  ) {}

  async take(subject: string): Promise<boolean> {
    const minute = Math.floor(Date.now() / 60_000);
    const key = `${this.keyPrefix}:${subject}:${minute}`;
    const count = await this.redis.eval(TAKE_SCRIPT, 1, key, 120_000);
    return Number(count) <= this.limitPerMinute;
  }
}

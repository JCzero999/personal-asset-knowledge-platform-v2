import { randomBytes } from "node:crypto";

/**
 * ULID：48 位毫秒时间戳 + 80 位随机数，Crockford Base32 编码为 26 字符。
 *
 * 不引入额外依赖：只有生成逻辑，没有引入「单调递增」保证（同一毫秒内
 * 多个 id 的先后顺序不保证）。需要严格单调时应改用数据库序号，而不是
 * 依赖 ULID 的随机段。
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(time: number): string {
  let remaining = time;
  let output = "";

  for (let index = 0; index < TIME_LEN; index += 1) {
    const mod = remaining % 32;
    output = ENCODING[mod] + output;
    remaining = Math.floor(remaining / 32);
  }

  return output;
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LEN);
  let output = "";

  for (const byte of bytes) {
    // 每字节取低 5 位，得到 0~31 的 Crockford 字符。
    output += ENCODING[byte & 31];
  }

  return output;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

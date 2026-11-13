import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * 设置项密钥盒（ADR-025）。
 *
 * - 算法：AES-256-GCM；密钥由应用密钥经 HKDF-SHA256 派生（salt/info 固定为
 *   本模块常量，换版本时升级 `VERSION` 并保留旧格式解析）。
 * - 序列化：`v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>`，IV 每次随机 12 字节。
 * - 应用密钥来源：只读专用 `SETTINGS_ENC_KEY`（ADR-025）。
 *   不回退 Logto 密钥：轮换登录密钥不应导致已存 API Key 解不开。
 *   缺失时由调用方返回明确错误，绝不静默降级或临时生成。
 * - 本模块只做「加解密 / 掩码 / 取密钥」，不读数据库、不写日志。
 */

export const SECRET_BOX_VERSION = "v1";

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HKDF_SALT = "pakp.settings.salt.v1";
const HKDF_INFO = "pakp.settings.aes-256-gcm";

/** 解密失败只暴露这一类错误，绝不把密文或密钥放进 message。 */
export class SecretBoxError extends Error {
  constructor(message = "密钥解密失败（应用密钥已更换或密文被篡改）") {
    super(message);
    this.name = "SecretBoxError";
  }
}

/** 返回专用设置密钥；缺失返回 null，由调用方给出可行动报错。 */
export function resolveSettingsSecret(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const value = env.SETTINGS_ENC_KEY?.trim();
  return value ? value : null;
}

function deriveKey(secret: string): Buffer {
  if (!secret.trim()) {
    throw new SecretBoxError("应用密钥为空，无法加解密设置项");
  }

  const derived = hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from(HKDF_SALT, "utf8"),
    Buffer.from(HKDF_INFO, "utf8"),
    KEY_LENGTH,
  );

  return Buffer.from(derived);
}

export function encryptSecret(plaintext: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    SECRET_BOX_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string, secret: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== SECRET_BOX_VERSION) {
    throw new SecretBoxError("密文格式不受支持");
  }

  const [, ivPart, tagPart, dataPart] = parts;
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const data = Buffer.from(dataPart, "base64url");

  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new SecretBoxError("密文格式不受支持");
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretBoxError();
  }
}

/**
 * 掩码：只保留可辨认的前缀与末 4 位，例如 `sk-…bcde`。
 * 长度不足 8 时只留末 2 位，绝不返回原文。
 */
export function maskSecret(value: string | null | undefined): string | null {
  const plain = value?.trim();
  if (!plain) return null;
  if (plain.length < 5) return "…";
  if (plain.length < 12) return `…${plain.slice(-2)}`;
  return `${plain.slice(0, 3)}…${plain.slice(-4)}`;
}

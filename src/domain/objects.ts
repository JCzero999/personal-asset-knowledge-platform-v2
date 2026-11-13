/**
 * 业务对象（资产 / 作品）的纯领域类型与取值集合。
 *
 * 本文件不引入任何 IO，也不依赖数据库或框架；持久化层负责把这些取值
 * 映射到 `objects` 表。规则本身（例如外库作品不能 practiced）由
 * `workflow.ts` 与数据库 CHECK 约束共同保证。
 */

export const objectTypes = ["asset", "work"] as const;
export type ObjectType = (typeof objectTypes)[number];

/** 内库 = 已验证、可复用；外库 = 输入与待验证。单值互斥（ADR-008）。 */
export const libraries = ["internal", "external"] as const;
export type Library = (typeof libraries)[number];

export const priorities = ["low", "medium", "high"] as const;
export type Priority = (typeof priorities)[number];

/** 来源：谁写的（ADR-008 与验证程度正交的维度）。 */
export const objectSources = ["handwritten", "ai_extracted"] as const;
export type ObjectSource = (typeof objectSources)[number];

/** 来路：自己的还是导入的。 */
export const objectOrigins = ["self", "imported"] as const;
export type ObjectOrigin = (typeof objectOrigins)[number];

/**
 * 内置分类种子（ADR-016 建立，ADR-023 改名）。
 *
 * 分类已经词表化：真相源是数据库里的 `categories`，运行时一律通过
 * `GET /api/vocabulary` / `listVocabulary()` 读取。这里只剩「迁移种子 +
 * 测试 fixture」两种用途，禁止在业务代码里 import。
 */
export const SYSTEM_CATEGORY_SEEDS = [
  { code: "article", label: "文章" },
  { code: "script", label: "音视频脚本" },
  { code: "course", label: "课程" },
  { code: "live", label: "直播" },
  { code: "consult", label: "咨询" },
  { code: "flomo", label: "外部笔记" },
  { code: "uncategorized", label: "未分类" },
] as const;

/** 分类 code 由词表维护，领域层只保证它是非空字符串（合法性由外键兜底）。 */
export type Category = string;

export const workStatuses = ["draft", "finished", "published", "practiced"] as const;
export type WorkStatus = (typeof workStatuses)[number];

/** 公共字段；`status` / `sourceNote` 仅作品有值，资产恒为 null；分类两者都可有。 */
export interface ObjectBase {
  /** ULID，业务唯一身份。 */
  id: string;
  type: ObjectType;
  title: string;
  description: string | null;
  library: Library;
  source: ObjectSource;
  origin: ObjectOrigin;
  /** 分类 code（ADR-023）：作品必有、资产可空。 */
  category: string | null;
  tags: string[];
  priority: Priority;
  /** 归档时间；归档只改元数据，不移动内容（ADR-007）。 */
  archivedAt: string | null;
  /** 最近一次跨库迁移时间；与 library_events 审计表对应。 */
  libraryChangedAt: string | null;
  /** 单用户场景下仍是 Logto 的 sub，保留字段以便后续多用户演进。 */
  ownerSub: string;
  /** 乐观锁版本号，每次写入 +1。 */
  revision: number;
  /** UTC ISO-8601。 */
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AssetObject extends ObjectBase {
  type: "asset";
  category: string | null;
  status: null;
  sourceNote: null;
}

export interface WorkObject extends ObjectBase {
  type: "work";
  category: Category;
  status: WorkStatus;
  /** 转资产 / 外部导入时的来源说明。 */
  sourceNote: string | null;
}

export type BusinessObject = AssetObject | WorkObject;

export function isWorkStatus(value: unknown): value is WorkStatus {
  return typeof value === "string" && (workStatuses as readonly string[]).includes(value);
}

export function isCategory(value: unknown): value is Category {
  // 取值域已经搬进 categories 词表：这里只挡住空值，具体 code 是否存在由外键保证。
  return typeof value === "string" && value.trim().length > 0;
}

export function isLibrary(value: unknown): value is Library {
  return typeof value === "string" && (libraries as readonly string[]).includes(value);
}

export function isObjectType(value: unknown): value is ObjectType {
  return typeof value === "string" && (objectTypes as readonly string[]).includes(value);
}

export function isAsset(object: BusinessObject): object is AssetObject {
  return object.type === "asset";
}

export function isWork(object: BusinessObject): object is WorkObject {
  return object.type === "work";
}

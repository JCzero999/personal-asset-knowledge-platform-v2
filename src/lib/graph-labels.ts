/**
 * 实体标签的展示顺序。
 *
 * LightRAG 的标签按字典序返回，抽取噪声（如单独的「#」）会排在中文实体前面。
 * 这里只调整顺序、不丢数据：含文字或数字的实体优先，其余保持原样排在后面。
 */

const HAS_WORD = /[\p{L}\p{N}]/u;

export function sortLabels(labels: string[]): string[] {
  return [...labels].sort((a, b) => {
    const weight = Number(HAS_WORD.test(b)) - Number(HAS_WORD.test(a));
    return weight !== 0 ? weight : a.localeCompare(b);
  });
}

/** 首屏默认展开的实体；没有可用标签时返回 null。 */
export function pickInitialLabel(labels: string[]): string | null {
  return sortLabels(labels)[0] ?? null;
}

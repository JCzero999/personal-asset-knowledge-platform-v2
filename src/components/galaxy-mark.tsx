import { Icon } from "./icon";

/**
 * 银河星系标志（设计稿 §2.1）。
 *
 * - 19–24px：单色线性版本，复用 `Icon` 的 galaxy 造型；
 * - 28px：品牌渐变版本，用于 36px 玻璃徽章容器。
 *
 * 渐变 id 由调用处传入，保证同页多个实例（导航栏 / 首页顶栏 / 抽屉）
 * 各自唯一，同时避免在服务端组件里用 `useId`。
 */
export function GalaxyMark({
  size = 28,
  id = "galaxy-mark",
}: {
  size?: number;
  id?: string;
}) {
  if (size <= 24) {
    return <Icon name="galaxy" size={size} strokeWidth={1.5} />;
  }

  return (
    <svg
      aria-hidden="true"
      className="galaxy-mark-svg"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <defs>
        <linearGradient id={id} x1="4" x2="20" y1="4" y2="20" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--galaxy-from, #8fd3b0)" />
          <stop offset="1" stopColor="var(--galaxy-to, #4a8b69)" />
        </linearGradient>
      </defs>
      <ellipse
        cx="12"
        cy="12"
        opacity=".35"
        rx="9.2"
        ry="3.6"
        stroke="currentColor"
        strokeWidth="1.6"
        transform="rotate(-24 12 12)"
      />
      <path
        d="M12 12c1.6-2.6 4.9-3.4 7.1-1.5 2.3 2 1.9 5.6-.8 7.2-3 1.8-7 .5-8.4-2.7-1.2-2.8.3-6 3-7.4"
        stroke={`url(#${id})`}
        strokeLinecap="round"
        strokeWidth="1.6"
      />
      <path
        d="M12 12c-1.6 2.6-4.9 3.4-7.1 1.5-2.3-2-1.9-5.6.8-7.2 3-1.8 7-.5 8.4 2.7 1.2 2.8-.3 6-3 7.4"
        opacity=".75"
        stroke={`url(#${id})`}
        strokeLinecap="round"
        strokeWidth="1.6"
      />
      <circle cx="12" cy="12" fill="currentColor" r="2.4" />
      <circle cx="19.2" cy="6.6" fill="currentColor" opacity=".7" r=".9" />
    </svg>
  );
}

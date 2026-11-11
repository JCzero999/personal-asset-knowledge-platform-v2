import Link from "next/link";

import { Icon } from "@/components/icon";

/** 对象不存在或不属于当前用户：沿用错误页样式，给出回工作台的路。 */
export default function ObjectNotFound() {
  return (
    <main className="error-page">
      <span className="error-icon"><Icon name="search" size={26} /></span>
      <h1>找不到这条内容</h1>
      <p>它可能已被删除，或者不属于当前账号。回到工作台看看还在的内容。</p>
      <Link className="btn btn-primary" href="/workspace">回到工作台</Link>
    </main>
  );
}

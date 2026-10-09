import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

// 线程视图移植 pi 1.1.0 原生选择器：按 parentSessionPath 建立层级，
// 根与子节点都按子树最新活动时间降序排列。

export interface SessionTreeNode {
  session: SessionInfo;
  depth: number;
  isLast: boolean;
  /** 每一层祖先是否还有后续兄弟节点，用于渲染 │/空格缩进。 */
  ancestorContinues: boolean[];
}

export function canonicalizePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

interface MutableNode {
  session: SessionInfo;
  children: MutableNode[];
  latestActivity: number;
}

/**
 * 构建线程树并展平为展示顺序。
 *
 * 无搜索的线程模式使用该结果：父会话在前，子会话紧随其后并带层级前缀。
 */
export function buildSessionRows(sessions: readonly SessionInfo[]): SessionTreeNode[] {
  const byPath = new Map<string, MutableNode>();
  for (const session of sessions) {
    const key = canonicalizePath(session.path) ?? session.path;
    byPath.set(key, { session, children: [], latestActivity: session.modified.getTime() });
  }

  const roots: MutableNode[] = [];
  for (const session of sessions) {
    const key = canonicalizePath(session.path) ?? session.path;
    const node = byPath.get(key);
    if (!node) continue;
    const parentKey = canonicalizePath(session.parentSessionPath);
    const parent = parentKey ? byPath.get(parentKey) : undefined;
    // 自引用或缺失父节点时按根节点处理，避免出现环。
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  const updateLatestActivity = (node: MutableNode): number => {
    let latest = node.session.modified.getTime();
    for (const child of node.children) {
      latest = Math.max(latest, updateLatestActivity(child));
    }
    node.latestActivity = latest;
    return latest;
  };
  for (const root of roots) updateLatestActivity(root);

  const sortNodes = (nodes: MutableNode[]) => {
    nodes.sort((a, b) => b.latestActivity - a.latestActivity);
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);

  const rows: SessionTreeNode[] = [];
  const walk = (node: MutableNode, depth: number, ancestorContinues: boolean[], isLast: boolean) => {
    rows.push({ session: node.session, depth, isLast, ancestorContinues });
    for (let i = 0; i < node.children.length; i++) {
      const childIsLast = i === node.children.length - 1;
      // 顶层根节点之后不画延续竖线。
      const continues = depth > 0 ? !isLast : false;
      walk(node.children[i], depth + 1, [...ancestorContinues, continues], childIsLast);
    }
  };
  for (let i = 0; i < roots.length; i++) {
    walk(roots[i], 0, [], i === roots.length - 1);
  }
  return rows;
}

/** 渲染展示行使用的树形前缀；根节点不缩进。 */
export function buildTreePrefix(node: SessionTreeNode): string {
  if (node.depth === 0) return "";
  const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
  return parts.join("") + (node.isLast ? "└─ " : "├─ ");
}

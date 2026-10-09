import type { SessionDetails } from "./session-details.ts";

/** 单条会话增强信息的加载状态；未就绪时渲染加载态，不伪造 0、unknown 或无消息。 */
export type DetailsState =
  | { status: "loading" }
  | { status: "failed" }
  | ({ status: "ready" } & SessionDetails);

/** 一次读取请求：会话身份与它当前的可见性。 */
interface ReadRequest {
  path: string;
  foreground: boolean;
}

/** 正在进行的读取；可见性变化时更新 foreground，需要槽位时按 controller 中止。 */
interface RunningRead extends ReadRequest {
  controller: AbortController;
}

export interface DetailsSchedulerOptions {
  /** 读取单条会话的增强信息；signal 中止表示这次结果已不再需要。 */
  read(path: string, signal: AbortSignal): Promise<SessionDetails>;
  /** 新的最终状态可供渲染时触发；被抢占的读取不触发。 */
  onUpdate(): void;
}

/** 前台（当前可见）读取的并发上限。 */
const MAX_FOREGROUND_READS = 4;

/** 后台读取的并发上限；可见项需要槽位时后台读取让位，而不是堵住可见项。 */
const MAX_BACKGROUND_READS = 1;

/** 共享的加载状态；只读渲染，不需要每个会话各建一个。 */
const LOADING: DetailsState = { status: "loading" };

/**
 * 增强信息读取调度器。
 *
 * 只负责「读哪条、以什么优先级读、什么结果可以落地」：结果按会话身份保存，
 * 排队顺序按可见性重排，可见项（当前视口内与全文目标）优先于不可见项；
 * 为可见项腾出并发槽位时会中止已不可见的读取，并放回后台队列稍后补读。
 * 渲染、列表状态与展开状态仍由选择器持有。
 */
export class DetailsScheduler {
  private readonly options: DetailsSchedulerOptions;
  private readonly results = new Map<string, DetailsState>();
  /** 排队中的读取，键为会话身份；Map 的迭代顺序就是调度顺序。 */
  private readonly pending = new Map<string, ReadRequest>();
  private readonly running = new Map<string, RunningRead>();
  private readonly preempted = new Set<string>();
  private stopped = false;

  constructor(options: DetailsSchedulerOptions) {
    this.options = options;
  }

  /** 当前状态；从未请求读取的会话返回 undefined，由调用方决定是否显示加载态。 */
  get(path: string): DetailsState | undefined {
    const result = this.results.get(path);
    if (result) return result;
    return this.pending.has(path) || this.running.has(path) ? LOADING : undefined;
  }

  /** 请求读取这些会话（后台优先级）；已有结果、已排队或正在读取的保持不变。 */
  enqueue(paths: readonly string[]): void {
    if (this.add(paths)) this.pump();
  }

  /**
   * 声明当前可见的会话（视口内与全文目标），按给定顺序优先读取。
   *
   * 不再可见的读取降级为后台；需要并发槽位时中止它们并稍后补读，
   * 因此滚动、查询、筛选与范围切换后的可见项不会被旧的慢读取挡住。
   */
  prioritize(paths: readonly string[]): void {
    if (this.stopped) return;
    this.add(paths);
    const order = new Map(paths.map((path, index) => [path, index]));
    const foreground: ReadRequest[] = [];
    const background: ReadRequest[] = [];
    for (const item of this.pending.values()) {
      item.foreground = order.has(item.path);
      (item.foreground ? foreground : background).push(item);
    }
    foreground.sort((a, b) => (order.get(a.path) as number) - (order.get(b.path) as number));
    this.pending.clear();
    for (const item of [...foreground, ...background]) this.pending.set(item.path, item);
    for (const read of this.running.values()) read.foreground = order.has(read.path);
    this.pump();
  }

  /** 中止全部读取；之后不再调度，也不再产生新状态。 */
  stop(): void {
    this.stopped = true;
    this.pending.clear();
    for (const read of this.running.values()) read.controller.abort();
    this.running.clear();
  }

  /** 把未见过的会话加入后台队列；返回是否新增了读取。 */
  private add(paths: readonly string[]): boolean {
    if (this.stopped) return false;
    let added = false;
    for (const path of paths) {
      if (this.results.has(path) || this.pending.has(path) || this.running.has(path)) continue;
      this.pending.set(path, { path, foreground: false });
      added = true;
    }
    return added;
  }

  /** 按前台优先、后台补齐的规则启动读取，必要时先抢占已不可见的读取。 */
  private pump(): void {
    if (this.stopped) return;
    while (this.pending.size > 0) {
      let next: ReadRequest | undefined;
      for (const item of this.pending.values()) {
        if (!item.foreground) continue;
        next = item;
        break;
      }
      const hasForegroundPending = next !== undefined;
      if (!next) next = this.pending.values().next().value as ReadRequest;
      if (next.foreground) {
        while (this.needsForegroundSlot()) {
          if (!this.preemptUnseenRead()) return;
        }
      } else {
        // 仍可见的会话尚未补齐时，后台读取不占用槽位。
        if (hasForegroundPending) break;
        if (this.countRunning(false) >= MAX_BACKGROUND_READS
          || this.running.size >= MAX_FOREGROUND_READS + MAX_BACKGROUND_READS) break;
      }
      this.pending.delete(next.path);
      this.start(next);
    }
  }

  /** 前台槽位是否已满，或总并发已达上限。 */
  private needsForegroundSlot(): boolean {
    return this.countRunning(true) >= MAX_FOREGROUND_READS
      || this.running.size >= MAX_FOREGROUND_READS + MAX_BACKGROUND_READS;
  }

  private countRunning(foreground: boolean): number {
    let count = 0;
    for (const read of this.running.values()) if (read.foreground === foreground) count++;
    return count;
  }

  /** 中止一个已不可见的读取，为可见项腾出槽位；没有可抢占的读取时返回 false。 */
  private preemptUnseenRead(): boolean {
    for (const read of this.running.values()) {
      if (read.foreground || this.preempted.has(read.path)) continue;
      this.preempted.add(read.path);
      read.controller.abort();
      return true;
    }
    return false;
  }

  private start(item: ReadRequest): void {
    const controller = new AbortController();
    const read: RunningRead = { path: item.path, foreground: item.foreground, controller };
    this.running.set(item.path, read);
    void this.options.read(item.path, controller.signal).then(
      (details) => this.settle(read, { status: "ready", ...details }),
      () => this.settle(read, { status: "failed" }),
    );
  }

  /** 读取结束：被抢占的结果作废并回到后台队列，其余按会话身份落地。 */
  private settle(read: RunningRead, state: DetailsState): void {
    if (this.running.get(read.path) !== read) return; // stop() 之后的结果直接丢弃
    this.running.delete(read.path);
    if (this.stopped) return;
    if (this.preempted.delete(read.path)) {
      this.pending.set(read.path, { path: read.path, foreground: false });
    } else {
      this.results.set(read.path, state);
      this.options.onUpdate();
    }
    this.pump();
  }
}

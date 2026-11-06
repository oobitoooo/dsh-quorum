// dsh-quorum / sandbox.js —— 上下文沙箱
//
// 三条不变量（本文件负责前两条，第三条在 report/egress 里）：
//   1. 隔离：每个席位一个独立 messages 数组，互相不可见；跨席位共享同一数组对象即视为缺陷。
//   2. 单向入站：外部文本只能通过 brief() 进入沙箱，且必须是编排器显式构造的简报。
//   3. 出口收窄：整场辩论只有 buildReport() 的产物能回主上下文，raw 全文只能落盘调试。
//
// 这是「不把辩论过程倒进主上下文」的机械保证——不是靠提示词自觉。

export class AgentContext {
  /** @param {{id: string, name: string}} persona */
  constructor(persona) {
    this.id = persona.id;
    this.name = persona.name;
    /** @type {{role: 'system'|'user'|'assistant', content: string}[]} */
    this.messages = [];
    this.turns = [];
    this.createdAt = Date.now();
  }

  /** 系统提示只在建仓时写一次，之后不可改（防止跨轮注入漂移）。 */
  seedSystem(prompt) {
    if (this.messages.length > 0) throw new Error(`${this.id} 的系统提示已存在，禁止二次写入`);
    this.messages.push({ role: 'system', content: String(prompt) });
    return this;
  }

  /** 外部输入唯一入口。 */
  brief(text) {
    this.messages.push({ role: 'user', content: String(text) });
    return this;
  }

  /** 记录本席位自己的输出。 */
  record(text, meta = {}) {
    const content = String(text ?? '');
    this.messages.push({ role: 'assistant', content });
    this.turns.push({ round: meta.round ?? 0, chars: content.length, at: Date.now() });
    return content;
  }

  /** 只读视图：调用方拿到的是拷贝，改不动沙箱内部状态。 */
  get view() {
    return this.messages.map((m) => ({ ...m }));
  }

  get charCount() {
    return this.messages.reduce((n, m) => n + m.content.length, 0);
  }
}

export class QuorumSandbox {
  /**
   * @param {{id: string, name: string}[]} personas
   */
  constructor(personas) {
    if (!Array.isArray(personas) || personas.length === 0) throw new Error('沙箱至少需要一个席位');
    /** @type {Map<string, AgentContext>} */
    this.contexts = new Map();
    for (const persona of personas) this.contexts.set(persona.id, new AgentContext(persona));
    this.createdAt = Date.now();
  }

  get(personaId) {
    const ctx = this.contexts.get(personaId);
    if (!ctx) throw new Error(`沙箱里没有席位 ${personaId}`);
    return ctx;
  }

  ids() {
    return [...this.contexts.keys()];
  }

  /**
   * 隔离自检：任意两个上下文的 messages 数组不能是同一对象，也不能共享消息对象。
   * 编排器每轮开跑前调用一次——成本极低，能在源头拦住"图省事直接塞引用"的写法。
   */
  assertIsolated() {
    const seenArrays = new Set();
    const seenMessages = new Set();
    for (const [id, ctx] of this.contexts) {
      if (seenArrays.has(ctx.messages)) throw new Error(`上下文泄漏：${id} 与其他席位共享 messages 数组`);
      seenArrays.add(ctx.messages);
      for (const message of ctx.messages) {
        if (seenMessages.has(message)) throw new Error(`上下文泄漏：${id} 与其他席位共享消息对象`);
        seenMessages.add(message);
      }
    }
    return true;
  }

  /** 全量对话，仅用于落盘调试，绝不进入返回给主工作流的内容。 */
  transcript() {
    return this.ids().map((id) => ({
      id,
      messages: this.contexts.get(id).messages.map((m) => ({ role: m.role, content: m.content })),
      turns: this.contexts.get(id).turns.map((t) => ({ ...t })),
    }));
  }

  stats() {
    return this.ids().map((id) => {
      const ctx = this.contexts.get(id);
      return { id, messages: ctx.messages.length, chars: ctx.charCount, turns: ctx.turns.length };
    });
  }
}

/**
 * 出口守卫：报告的正文里不允许出现任何席位的长段原文。
 * 命中即抛错——宁可让编排器拆掉这条链路，也不让全文悄悄灌进主上下文。
 *
 * @param {string} text 待回传的 Markdown
 * @param {QuorumSandbox} sandbox
 * @param {{maxSpan?: number, tolerance?: number}} [options] maxSpan 默认 90；tolerance 是允许的命中字数（默认 0）
 */
export function assertNoTranscript(text, sandbox, options = {}) {
  // 90 字是一个刻意的门槛：报告里允许出现短引用（≤72 字），但连续 90 字原文只能是倒灌。
  const maxSpan = options.maxSpan ?? 90;
  const body = String(text ?? '');
  const tolerance = options.tolerance ?? 0;
  let leaked = 0;
  const offenders = [];

  for (const id of sandbox.ids()) {
    for (const message of sandbox.get(id).messages) {
      // 只扫席位自己产出的内容。user 消息里装的是主任务需求与 relay，本来就是调用方的原文；
      // 摘要里引用需求不是泄漏（不扫就会把"报告原样引用需求"误判成倒灌）。
      if (message.role !== 'assistant') continue;
      const content = message.content;
      if (content.length < maxSpan) continue;
      // 滑动窗口抽样：每 maxSpan 取一段，命中即记长度（避免 O(n^2)）
      for (let i = 0; i + maxSpan <= content.length; i += maxSpan) {
        const span = content.slice(i, i + maxSpan);
        if (body.includes(span)) {
          leaked += maxSpan;
          if (offenders.length < 5) offenders.push({ id, span: span.slice(0, 30) });
          break;
        }
      }
    }
  }

  if (leaked > tolerance) {
    const error = new Error(
      `出口守卫拦截：报告疑似包含辩论原文（连续 ${maxSpan} 字命中 × ${Math.round(leaked / maxSpan)} 处）。` +
        `命中来源：${offenders.map((o) => o.id).join(', ')}。全文应只落盘，不回上下文。`,
    );
    error.code = 'QUORUM_EGRESS_LEAK';
    error.leaked = leaked;
    error.offenders = offenders;
    throw error;
  }
  return { leaked, maxSpan, tolerance };
}

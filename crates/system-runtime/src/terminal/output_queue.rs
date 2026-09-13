//! 有界输出交付队列（W2-2）：Rust 侧唯一背压原语。
//! 生产者（PTY 读线程）→ 未确认窗口（≤256 KiB，满则暂停读取、不丢字节）→
//! 唯一 sender 取帧交付 → ack 累计确认后出队释放窗口（设计 spec §5 创建与
//! attach、§6 输出与背压）。TS 侧的消费者代际与 16ms 合帧不归本队列管：
//! 这里只承诺「按序、有界、可回收」三件事。
//!
//! 不变量：
//! - 帧只在 ack 时出队：deque 中同时含「未发出」与「已发未确认」两段，
//!   `emitted_upto` 是两段边界（ack 的 `seq < next-emitted` 守卫由此而来）。
//! - seq 由唯一生产者密发（fetch_add 先于 push），单 sender 保序 → 消费端
//!   看到的 outputSeq 连续；attach 门控只影响「发出」，不影响「编号」。

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// 单帧原始字节上限（spec §6 资源预算；macOS PTY 量子 ~1 KiB 时结构成立即可）。
pub const MAX_FRAME_BYTES: usize = 16 * 1024;
/// 每终端未确认输出窗口：queued（未发出）+ emitted 未 ack 的字节总和上限。
pub const MAX_PENDING_BYTES: usize = 256 * 1024;

/// 已 attach 时尾部交付等待总预算（spec §6「尾部先于 exited」+ §8 关停预算）。
const DRAIN_BUDGET: Duration = Duration::from_millis(2_000);
/// 从未 attach 的弃终：尾部交付有界放弃（spec §6「异常断开允许尾部丢失」的
/// 弃终等价——没消费者在听，exited 不该被 256 KiB 窗口卡满整个预算）。
const UNATTACHED_GRACE: Duration = Duration::from_millis(500);

/// 一帧输出：seq 供消费端检测缺口，bytes 为原始 PTY 字节。
#[derive(Clone)]
pub struct Frame {
    pub seq: u64,
    pub bytes: Vec<u8>,
}

struct QueueState {
    /// deque 内全部帧都占窗口额度；只有 ack 出队才释放。
    frames: VecDeque<Frame>,
    /// 已交给 sender 的帧数边界；头部出队时同步递减。
    emitted_upto: usize,
    /// frames 内字节总和（窗口占用，= queued + emitted 未 ack）。
    total_bytes: usize,
    attached: bool,
    /// 消费者身份仅用于日志诊断；代际裁决在 TS 侧。
    consumer_id: String,
    closed: bool,
}

/// 窗口裁决的唯一谓词（push 的等待条件与对外观测共用，防口径漂移）。
fn reader_should_pause(state: &QueueState) -> bool {
    !state.closed && state.total_bytes > MAX_PENDING_BYTES
}

pub struct OutputQueue {
    inner: Mutex<QueueState>,
    cond: Condvar,
}

impl OutputQueue {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(QueueState {
                frames: VecDeque::new(),
                emitted_upto: 0,
                total_bytes: 0,
                attached: false,
                consumer_id: String::new(),
                closed: false,
            }),
            cond: Condvar::new(),
        }
    }

    /// 中毒锁不致命：状态机各临界区都收在赋值级，取回内部值继续比整条
    /// 输出链静默死亡更可诊断。
    fn lock(&self) -> MutexGuard<'_, QueueState> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 纯谓词：窗口满且未关闭 → 生产者应暂停 PTY 读取。
    pub fn wants_reader_pause(&self) -> bool {
        reader_should_pause(&self.lock())
    }

    /// 阻塞入队：等窗口腾空后 push。队列已关闭返回 false（帧丢弃）。
    /// 调用方（生产者）收到 false 后**不得停止读取**——必须继续排空 PTY
    /// 并丢弃输出直到 EOF，否则 dying shell 的收尾写会填满 master 队列并
    /// 卡死在内核 exit 路径（见 session.rs 生产线程注释的回归教训）。
    pub fn push(&self, frame: Frame) -> bool {
        let mut state = self.lock();
        while reader_should_pause(&state) {
            state = self.cond.wait(state).unwrap_or_else(|p| p.into_inner());
        }
        if state.closed {
            return false;
        }
        state.total_bytes += frame.bytes.len();
        state.frames.push_back(frame);
        drop(state);
        // sender（新帧可发）与退出线程（尾部条件变化）共用一条 condvar；
        // 帧频低（控制面级别），notify_all 足够。
        self.cond.notify_all();
        true
    }

    /// 唯一 sender 的等待取帧：阻塞到 attached 且有未发帧；整段未发帧被
    /// 克隆出锁（bytes 拷出即交付，绝不在持队列锁时触碰 STDOUT_LOCK）。
    /// 返回 None 表示队列已关闭，sender 应退出。帧不出队——等 ack。
    pub fn take_emit_batch(&self) -> Option<Vec<Frame>> {
        let mut state = self.lock();
        loop {
            if state.closed {
                return None;
            }
            if state.attached && state.emitted_upto < state.frames.len() {
                let batch: Vec<Frame> = state.frames.range(state.emitted_upto..).cloned().collect();
                state.emitted_upto = state.frames.len();
                drop(state);
                self.cond.notify_all();
                return Some(batch);
            }
            state = self.cond.wait(state).unwrap_or_else(|p| p.into_inner());
        }
    }

    /// attach：打开交付闸门；返回「此刻队列中尚未发出字节」的快照
    /// （racing 生产者可能随后再追加，按定义允许）。幂等：重复 attach
    /// 只更新消费者并重新快照——旧消费者的排除由 TS 侧代际完成。
    pub fn attach(&self, consumer_id: &str) -> usize {
        let mut state = self.lock();
        let replayed = state
            .frames
            .range(state.emitted_upto..)
            .map(|frame| frame.bytes.len())
            .sum();
        state.attached = true;
        state.consumer_id = consumer_id.to_string();
        drop(state);
        self.cond.notify_all();
        replayed
    }

    /// 当前消费者标识（attach 日志用）。
    pub fn consumer_id(&self) -> String {
        self.lock().consumer_id.clone()
    }

    /// 累计确认：弹出「已发出且 seq ≤ through」的头部帧并归还窗口额度。
    /// `emitted_upto > 0` 守卫即「seq < next-emitted」——未发出的帧即使
    /// seq 命中也不出队（ack 超前于交付是消费端 bug，不为其丢数据）。
    /// 过期/重复 ack 天然 no-op；关闭后 ack 同样静默成功（幂等）。
    pub fn ack(&self, through_output_seq: u64) {
        let mut state = self.lock();
        let mut popped = 0usize;
        while state.emitted_upto > 0 {
            match state.frames.front() {
                Some(frame) if frame.seq <= through_output_seq => {
                    state.total_bytes -= frame.bytes.len();
                    state.frames.pop_front();
                    state.emitted_upto -= 1;
                    popped += 1;
                }
                _ => break,
            }
        }
        if popped > 0 {
            drop(state);
            self.cond.notify_all(); // 唤醒被窗口卡住的生产者与尾部等待
        }
    }

    /// 关闭：唤醒全部等待角色（producer/sender/尾部等待），抑制后续交付与
    /// exited 事件。已入队未 ack 的字节随队列整体释放。
    pub fn close(&self) {
        let mut state = self.lock();
        state.closed = true;
        drop(state);
        self.cond.notify_all();
    }

    pub fn is_closed(&self) -> bool {
        self.lock().closed
    }

    /// 退出线程尾部等待（spec §6「正常退出先交付尾部，再发布 exited」）：
    /// 等 sender 把当前已入队帧全部发出（emitted_upto == len）。
    /// - 已 attach：最多等 DRAIN_BUDGET（2 s，落在 §8 关停预算内）。
    /// - 从未 attach：等 UNATTACHED_GRACE（500 ms）后放弃——弃终没有听众。
    /// 返回 false 仅表示超时放弃（与 close 的「无需交付」区分开，便于测试）。
    pub fn wait_final_delivery(&self) -> bool {
        let started = Instant::now();
        let mut state = self.lock();
        loop {
            if state.closed {
                return true; // close 已接管：exited 会被抑制，无尾部义务
            }
            if state.emitted_upto >= state.frames.len() {
                return true; // 尾部交付完毕
            }
            let budget = if state.attached {
                DRAIN_BUDGET
            } else {
                UNATTACHED_GRACE
            };
            let elapsed = started.elapsed();
            if elapsed >= budget {
                return false;
            }
            let (next, _timeout) = self
                .cond
                .wait_timeout(state, budget - elapsed)
                .unwrap_or_else(|p| p.into_inner());
            state = next;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(seq: u64, len: usize) -> Frame {
        Frame {
            seq,
            bytes: vec![0x41; len],
        }
    }

    #[test]
    fn payload_is_chunked_at_16kib_boundary() {
        let payload = vec![0x41u8; MAX_FRAME_BYTES * 2 + 1];
        let sizes: Vec<usize> = payload.chunks(MAX_FRAME_BYTES).map(<[u8]>::len).collect();
        assert_eq!(sizes, vec![MAX_FRAME_BYTES, MAX_FRAME_BYTES, 1]);
    }

    /// 窗口谓词：恰好 256 KiB 不暂停（判据是「>」），超一字节暂停。
    #[test]
    fn window_pause_predicate_uses_strict_greater_than() {
        let queue = OutputQueue::new();
        queue.attach("t");
        assert!(!queue.wants_reader_pause());
        queue.push(frame(0, MAX_PENDING_BYTES));
        assert!(!queue.wants_reader_pause());
        queue.push(frame(1, 1));
        assert!(queue.wants_reader_pause());
    }

    /// ack 只出「已发出」段：未 emit 的帧即便 seq 命中也留在队列，
    /// 已 emit 段按 through 累计弹出并归还额度。
    #[test]
    fn ack_drains_only_emitted_prefix_and_frees_window() {
        let queue = OutputQueue::new();
        queue.push(frame(0, 100));
        queue.push(frame(1, 200));
        queue.attach("t");
        // attach 前 push 的帧未发出：超前 ack 无效。
        queue.ack(9);
        assert_eq!(queue.lock().total_bytes, 300);
        let batch = queue
            .take_emit_batch()
            .expect("attached 且有未发帧，立即返回");
        assert_eq!(batch.len(), 2);
        assert_eq!(queue.lock().emitted_upto, 2);
        // 只确认 seq 0：头部 100B 出队，边界回移到 1。
        queue.ack(0);
        assert_eq!(queue.lock().total_bytes, 200);
        assert_eq!(queue.lock().emitted_upto, 1);
        queue.ack(1);
        assert_eq!(queue.lock().total_bytes, 0);
        assert!(queue.lock().frames.is_empty());
    }

    /// 过期/重复 ack 幂等：不弹出、不减额度、不 panic。
    #[test]
    fn stale_and_duplicate_acks_are_idempotent() {
        let queue = OutputQueue::new();
        queue.ack(5); // 空队列 ack
        queue.attach("t");
        queue.push(frame(0, 10));
        let _ = queue.take_emit_batch().expect("batch");
        queue.ack(0);
        let total = queue.lock().total_bytes;
        queue.ack(0); // 重复
        queue.ack(0); // 重复
        assert_eq!(queue.lock().total_bytes, total);
        assert_eq!(total, 0);
    }

    /// attach 快照 =「尚未发出」的字节和；已发出未 ack 段不计入 replay。
    #[test]
    fn attach_reports_unemitted_bytes_snapshot_and_reattach_refreshes() {
        let queue = OutputQueue::new();
        queue.push(frame(0, 100));
        queue.push(frame(1, 200));
        assert_eq!(queue.attach("c1"), 300);
        assert_eq!(queue.consumer_id(), "c1");
        let _ = queue.take_emit_batch().expect("batch"); // 全部发出（未 ack）
        queue.push(frame(2, 50));
        // 已发出未 ack 的 300B 不再 replay；只有新未发帧 50B。
        assert_eq!(queue.attach("c2"), 50);
        assert_eq!(queue.consumer_id(), "c2");
    }

    /// 关闭后 push 直接拒收（false），ack 静默幂等。
    #[test]
    fn closed_queue_rejects_pushes_and_acks_quietly() {
        let queue = OutputQueue::new();
        queue.close();
        assert!(!queue.push(frame(0, 10)));
        queue.ack(0);
        assert!(queue.take_emit_batch().is_none());
        assert!(!queue.wants_reader_pause()); // 关闭状态永远不「暂停读取」——直接停
    }

    /// 未 attach 的弃终：wait_final_delivery 在 500ms 宽限内放弃（非阻塞死），
    /// 且返回 false 标记「尾部可能丢失」。
    #[test]
    fn unattached_drain_gives_up_within_grace() {
        let queue = OutputQueue::new();
        queue.push(frame(0, 100));
        let started = Instant::now();
        assert!(!queue.wait_final_delivery());
        assert!(started.elapsed() >= UNATTACHED_GRACE);
        assert!(started.elapsed() < UNATTACHED_GRACE + Duration::from_millis(300));
    }

    /// 空队列（或尾部已全部发出）时立即放行，不等预算。
    #[test]
    fn drained_or_empty_queue_releases_exit_immediately() {
        let queue = OutputQueue::new();
        assert!(queue.wait_final_delivery());
        queue.attach("t");
        queue.push(frame(0, 100));
        let _ = queue.take_emit_batch().expect("batch");
        let started = Instant::now();
        assert!(queue.wait_final_delivery());
        assert!(started.elapsed() < Duration::from_millis(50));
    }
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceFollowup, type FollowupEntry } from "../server/followup.ts";
import { jobSchema } from "../server/state-store.ts";

function watch() {
  const job = jobSchema.parse({ messageId: "m1", conversationKey: "dm:a", chatId: "a", senderId: "a", createdAt: 1, updatedAt: 1,
    followup: { cursor: { epoch: "e1", seq: 0 }, lastAnswer: "处理中", expiresAt: 9999999999999 } });
  return job.followup!;
}
function entry(seq: number, item: unknown): FollowupEntry { return { seqStart: seq, seqEnd: seq, item }; }
function user(id = "origin") { return { type: "user_message", messageId: id }; }
function launch(id: string, flags: { notify?: boolean; trigger?: boolean } = {}) {
  return { type: "tool_call", name: "bg_run", status: "completed", detail: { type: "unknown", output: { details: { task: {
    id, notifyOnCompletion: flags.notify ?? true, triggerOnCompletion: flags.trigger ?? true,
  } } } } };
}
function notification(id: string, trigger = true) {
  return { type: "tool_call", name: "background-task-notification", metadata: { synthetic: true, customType: "background-task-notification", details: { id, triggerOnCompletion: trigger } } };
}
function answer(id: string, text: string) { return { type: "assistant_message", messageId: id, text }; }

test("后台续跑只接受本次派发的任务通知并取通知后的最后答复", () => {
  const w = watch();
  assert.equal(advanceFollowup(w, [entry(1, user()), entry(2, launch("task-1")), entry(3, answer("a1", "处理中"))], "origin"), "ok");
  assert.deepEqual(w.pendingTasks, ["task-1"]);
  assert.equal(w.candidate, null);
  assert.equal(advanceFollowup(w, [entry(4, notification("unrelated", false)), entry(5, answer("a2", "不应转发"))], "origin"), "ok");
  assert.equal(w.candidate, null);
  assert.equal(advanceFollowup(w, [entry(6, notification("task-1")), entry(7, answer("a3", "中间说明")), entry(8, answer("a4", "最终结果"))], "origin"), "ok");
  assert.deepEqual(w.pendingTasks, []);
  assert.deepEqual(w.candidate, { id: "a4", text: "最终结果" });
});

test("关闭自动唤醒、伪造通知及无关联任务不会转发", () => {
  const w = watch();
  const fake = { ...notification("t1"), metadata: { synthetic: false, customType: "background-task-notification", details: { id: "t1", triggerOnCompletion: true } } };
  advanceFollowup(w, [entry(1, user()), entry(2, launch("t1", { trigger: false })), entry(3, launch("t2", { notify: false })), entry(4, fake), entry(5, notification("t2", false)), entry(6, answer("x", "private"))], "origin");
  assert.deepEqual(w.pendingTasks, []);
  assert.equal(w.candidate, null);
});

test("delegate 启动回执同样按任务 ID 关联", () => {
  const w = watch();
  const delegate = { ...launch("delegate-1"), name: "bg_delegate" };
  assert.equal(advanceFollowup(w, [entry(1, user()), entry(2, delegate), entry(3, notification("delegate-1")), entry(4, answer("a", "已完成"))], "origin"), "ok");
  assert.equal(w.candidate?.text, "已完成");
});

test("无关的自动唤醒使归属不确定，停止跟踪", () => {
  const w = watch();
  assert.equal(advanceFollowup(w, [entry(1, user()), entry(2, launch("t1")), entry(3, notification("other")), entry(4, answer("a", "不应转发"))], "origin"), "superseded");
  assert.equal(w.candidate, null);
});

test("同一后台任务发起新的后台任务时继续跟踪", () => {
  const w = watch();
  advanceFollowup(w, [entry(1, user()), entry(2, launch("t1")), entry(3, notification("t1")), entry(4, launch("t2")), entry(5, answer("a", "继续等待"))], "origin");
  assert.deepEqual(w.pendingTasks, ["t2"]);
  assert.equal(w.candidate?.text, "继续等待");
  advanceFollowup(w, [entry(6, notification("t2")), entry(7, answer("b", "结束"))], "origin");
  assert.equal(w.candidate?.text, "结束");
  assert.deepEqual(w.pendingTasks, []);
});

test("出现其他用户输入时立即停止，不转发后来内容", () => {
  const w = watch();
  const result = advanceFollowup(w, [entry(1, user()), entry(2, launch("t1")), entry(3, user("different")), entry(4, notification("t1")), entry(5, answer("a", "其他用户的答复"))], "origin");
  assert.equal(result, "superseded");
  assert.equal(w.candidate, null);
});

test("找不到自己的派发消息时不激活任何后台通知", () => {
  const w = watch();
  assert.equal(advanceFollowup(w, [entry(1, launch("t1")), entry(2, notification("t1")), entry(3, answer("a", "内容"))], "origin"), "ok");
  assert.equal(w.originSeen, false);
  assert.deepEqual(w.pendingTasks, []);
  assert.equal(w.candidate, null);
});

test("继承的待完成任务在本轮派发前已触发通知时自动核销，剩余任务在本轮后正常触发", () => {
  const w = watch();
  w.pendingTasks = ["inherited-done", "inherited-pending"];
  assert.equal(
    advanceFollowup(
      w,
      [
        entry(1, notification("inherited-done")),
        entry(2, user("m2")),
        entry(3, answer("a1", "本轮正常回复")),
      ],
      "m2",
    ),
    "ok",
  );
  assert.equal(w.originSeen, true);
  assert.deepEqual(w.pendingTasks, ["inherited-pending"]);
  assert.equal(w.candidate, null);
  assert.equal(
    advanceFollowup(
      w,
      [entry(4, notification("inherited-pending")), entry(5, answer("a2", "跨轮后台最终回复"))],
      "m2",
    ),
    "ok",
  );
  assert.deepEqual(w.pendingTasks, []);
  assert.deepEqual(w.candidate, { id: "a2", text: "跨轮后台最终回复" });
});

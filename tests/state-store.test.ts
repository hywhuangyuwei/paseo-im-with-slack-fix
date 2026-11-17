import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, emptyState } from "../server/state-store.ts";

async function withStore(run: (store: StateStore, path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "paseo-im-state-"));
  const store = new StateStore("00000000-0000-4000-8000-000000000000", root);
  try {
    await run(store, join(root, "state.json"));
  } finally {
    // 先排空 fire-and-forget 写链再删目录：杜绝 atomicWrite 与 rm 的竞态（ENOTEMPTY）。
    await store.drain().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

test("空状态符合 schema 默认值", () => {
  const state = emptyState();
  assert.deepEqual(state.seenMessageIds, []);
  assert.deepEqual(state.jobs, {});
  assert.equal(state.ownerId, null);
});

test("ensureJob 幂等且字段齐全", async () => {
  await withStore(async (store) => {
    const job = store.ensureJob("m1", {
      messageId: "m1",
      conversationKey: "dm:alice",
      chatId: "alice",
      senderId: "alice",
      createdAt: Date.now(),
    });
    assert.equal(job.threadId, null);
    assert.equal(store.job("m1")?.messageId, "m1");
    const again = store.ensureJob("m1", {
      messageId: "m1",
      conversationKey: "dm:other",
      chatId: "other",
      senderId: "other",
      createdAt: 0,
    });
    assert.equal(again.conversationKey, "dm:alice");
  });
});

test("updateJob 打补丁并刷新时间戳", async () => {
  await withStore(async (store) => {
    store.ensureJob("m1", {
      messageId: "m1",
      conversationKey: "dm:alice",
      chatId: "alice",
      senderId: "alice",
      createdAt: 1,
    });
    const updated = store.updateJob("m1", { dispatch: "sent" });
    assert.equal(updated?.dispatch, "sent");
    assert.ok((updated?.updatedAt ?? 0) >= Date.now() - 5_000);
  });
});

test("resumableJobs 取每会话最新冻结 job，排除已送达/已失败/待回答问题", async () => {
  await withStore(async (store) => {
    const mk = (id: string, conversationKey: string, createdAt: number) =>
      store.ensureJob(id, {
        messageId: id,
        conversationKey,
        chatId: conversationKey,
        senderId: conversationKey,
        createdAt,
      });
    mk("j-done", "dm:a", 1);
    store.updateJob("j-done", { dispatch: "sent", delivery: "done", createdAt: 1 });
    mk("j-failed", "dm:a", 2);
    store.updateJob("j-failed", { dispatch: "sent", failure: "boom", createdAt: 2 });
    mk("j-question", "dm:a", 3);
    store.updateJob("j-question", { dispatch: "sent", createdAt: 3, question: { requestId: "q1", fields: [], messageId: null, notified: true, status: "pending" } });
    // 未派发（队列被重载蒸发）与派发中（abort 打断标记）都是冻结态，入选
    mk("j-unsent", "dm:a", 4);
    store.updateJob("j-unsent", { createdAt: 4 });
    mk("j-sending", "dm:a", 5);
    store.updateJob("j-sending", { dispatch: "sending", createdAt: 5 });
    // 同会话最新者胜出
    mk("j-old", "dm:b", 6);
    store.updateJob("j-old", { dispatch: "sent", createdAt: 6 });
    mk("j-new", "dm:b", 7);
    store.updateJob("j-new", { dispatch: "sent", createdAt: 7 });
    mk("j-c", "dm:c", 8);
    store.updateJob("j-c", { dispatch: "sent", createdAt: 8 });

    const ids = store.resumableJobs().map((job) => job.messageId).sort();
    assert.deepEqual(ids, ["j-c", "j-new", "j-sending"]);
  });
});

test("resumableJobs restores model queries separately from unfinished model turns", async () => {
  await withStore(async (store) => {
    const jobs = [["turn", "prompt", 1], ["switch", "!m argon", 2],
      ["query-old", "!m", 3], ["query-new", "  !M  \n", 4]] as const;
    for (const [id, text, createdAt] of jobs) {
      store.ensureJob(id, { messageId: id, conversationKey: "dm:a", chatId: "a", senderId: "a", createdAt, text });
      store.updateJob(id, { createdAt });
    }
    await store.drain();
    await store.load();
    assert.deepEqual(store.resumableJobs().map(job => job.messageId), ["switch", "query-new"]);
    store.updateJob("switch", { delivery: "done" });
    // An unanswered read-only query must not hide a dispatched model task.
    store.updateJob("turn", { dispatch: "sent" });
    assert.deepEqual(store.resumableJobs().map(job => job.messageId), ["turn", "query-new"]);
  });
});

test("seen 环形去重上限 1000", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 1_100; i += 1) store.markSeen(`m-${i}`);
    assert.equal(store.get().seenMessageIds.length, 1000);
    assert.ok(store.hasSeen("m-1099"));
    assert.ok(!store.hasSeen("m-0"));
  });
});

test("mutate 持久化后可重载", async () => {
  await withStore(async (store, path) => {
    store.markSeen("m-1");
    await store.mutate((draft) => {
      draft.cursors["telegram"] = "12345";
      draft.groups["g-1"] = { title: "群" };
    });
    const reloaded = new StateStore("00000000-0000-4000-8000-000000000000", join(path, ".."));
    await reloaded.load();
    assert.equal(reloaded.cursor("telegram"), "12345");
    assert.ok(reloaded.hasSeen("m-1"));
    assert.equal(reloaded.get().groups["g-1"]?.title, "群");
  });
});

test("question 结构与 questionReply 校验", async () => {
  await withStore(async (store) => {
    store.ensureJob("m1", {
      messageId: "m1",
      conversationKey: "dm:a",
      chatId: "a",
      senderId: "a",
      createdAt: 1,
    });
    store.updateJob("m1", {
      question: {
        requestId: "r1",
        fields: [{ header: "选择", text: "用哪个模型？", options: ["A", "B"] }],
        messageId: null,
        notified: false,
        status: "pending",
      },
    });
    const job = store.job("m1");
    assert.equal(job?.question?.status, "pending");
    assert.equal(job?.questionReply, null);
  });
});

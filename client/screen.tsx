import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { Icon, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import {
  choicesRpc,
  connectRpc,
  disconnectRpc,
  listRpc,
  pairingPollRpc,
  pairingStartRpc,
  reviewRpc,
  revokeRpc,
  saveRpc,
  testRpc,
  type Choices,
  type ConnectionView,
} from "../shared/contracts.ts";
import { CHANNEL_LIST, type ChannelSpec } from "../shared/channels.ts";
import { imSettings } from "../shared/settings.ts";
import type { Connection, Policy, Target } from "../shared/config.ts";
import { RouteEditor, PolicyEditor, statusText } from "./route-editor.tsx";

const pollMs = 5_000;

interface ListResult {
  channels: { channel: string; connections: ConnectionView[] }[];
}

function useConnectionList(client: Pick<PluginClientContext, "rpc">, refreshToken: number): ListResult | null {
  const [result, setResult] = useState<ListResult | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = await client.rpc(listRpc, {});
        if (alive) setResult(next);
      } catch {
        // 轮询失败保留上次结果；错误在状态列显示。
      }
    };
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, refreshToken]);
  return result;
}

function statusColor(theme: PluginScreenProps["theme"], tone: "ok" | "warn" | "idle"): string {
  if (tone === "ok") return theme.colors.statusSuccess;
  if (tone === "warn") return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

function ConnectionsRow({
  theme,
  view,
  active,
  onPress,
}: {
  theme: PluginScreenProps["theme"];
  view: ConnectionView;
  active: boolean;
  onPress: () => void;
}) {
  const status = statusText(view);
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: active ? theme.colors.surface1 : "transparent",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusColor(theme, status.tone) }} />
        <Text style={{ color: theme.colors.foreground, flex: 1 }} numberOfLines={1}>
          {view.config.name}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{status.label}</Text>
      </View>
    </Pressable>
  );
}

// labelAccessory renders on the web host only and is absent from the mobile host + SDK types,
// so the reveal toggle lives in a plain Pressable strip under the input (renders everywhere).
function SecureField({
  theme,
  label,
  hint,
  placeholder,
  onTextChange,
}: {
  theme: PluginScreenProps["theme"];
  label: string;
  hint?: string;
  placeholder?: string;
  onTextChange: (text: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <View>
      <SettingsInput
        label={label}
        hint={hint}
        placeholder={placeholder}
        secureTextEntry={!revealed}
        onChangeText={onTextChange}
      />
      <Pressable
        onPress={() => setRevealed((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={revealed ? `隐藏${label}` : `显示${label}`}
        hitSlop={6}
        style={{
          flexDirection: "row",
          alignSelf: "flex-end",
          alignItems: "center",
          gap: 4,
          paddingVertical: 6,
          paddingHorizontal: 8,
        }}
      >
        <Icon name={revealed ? "eye-off" : "eye"} size={14} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{revealed ? "隐藏" : "显示明文"}</Text>
      </Pressable>
    </View>
  );
}

function ConnectForm({
  theme,
  spec,
  client,
  onDone,
}: {
  theme: PluginScreenProps["theme"];
  spec: ChannelSpec;
  client: Pick<PluginClientContext, "rpc">;
  onDone: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 扫码配对渠道（微信/WhatsApp/企微可选）：服务端 pairingStart 不带 connectionId
  // 时会自动创建连接并在配对成功后激活，避免「凭据只能由配对产生」的鸡生蛋死锁。
  const [pairAttempt, setPairAttempt] = useState<string | null>(null);
  const [pairQr, setPairQr] = useState<string | null>(null);
  const [pairStatus, setPairStatus] = useState<string | null>(null);
  const manual = spec.fields.length > 0;

  const statusLabel = (status: string, detail?: string | null) =>
    detail ? `${status}: ${detail}` : status === "pending" ? "等待扫码…" : status === "scanned" ? "已扫码，请在手机上确认" : status;

  const startPairing = async () => {
    setError(null);
    setPairQr(null);
    setPairStatus("准备中…");
    try {
      const result = await client.rpc(pairingStartRpc, { channel: spec.id });
      setPairAttempt(result.attemptId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    if (!pairAttempt) return;
    let alive = true;
    const poll = async () => {
      try {
        const result = await client.rpc(pairingPollRpc, { attemptId: pairAttempt });
        if (!alive) return;
        setPairQr(result.qrDataUrl ?? null);
        setPairStatus(statusLabel(result.status, result.detail));
        if (result.status === "ok") {
          setPairAttempt(null);
          if (result.connectionId) onDone(result.connectionId);
        } else if (result.status === "expired" || result.status === "failed") {
          setPairAttempt(null);
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
        setPairAttempt(null);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pairAttempt, client, onDone]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await client.rpc(connectRpc, { channel: spec.id, name: name || `${spec.title} 连接`, fields });
      onDone(result.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={`接入 ${spec.title}`}>
      <SettingsCard>
        {manual ? <SettingsInput label="连接名称" placeholder={`如 我的${spec.title}`} onChangeText={setName} /> : null}
        {spec.fields.map((field) =>
          field.secure ? (
            <SecureField
              key={field.key}
              theme={theme}
              label={field.label}
              hint={field.help}
              placeholder={field.placeholder}
              onTextChange={(value) => setFields((current) => ({ ...current, [field.key]: value }))}
            />
          ) : (
            <SettingsInput
              key={field.key}
              label={field.label}
              hint={field.help}
              placeholder={field.placeholder}
              onChangeText={(value) => setFields((current) => ({ ...current, [field.key]: value }))}
            />
          )
        )}
        {manual ? (
          <SettingsAction label="接入" actionLabel={busy ? "连接中…" : "连接"} disabled={busy} onPress={() => void submit()} />
        ) : null}
        {spec.pairing ? (
          pairAttempt ? (
            <>
              {pairQr ? (
                <Image source={{ uri: pairQr }} style={{ width: 220, height: 220, alignSelf: "center", margin: 12 }} />
              ) : null}
              <SettingsRow label="配对状态" hint="二维码过期或失败时点「重新扫码」">
                <Text style={{ color: theme.colors.foreground }}>{pairStatus ?? "…"}</Text>
              </SettingsRow>
              <SettingsAction
                label="重新扫码"
                actionLabel="重新扫码"
                onPress={() => {
                  setPairAttempt(null);
                  void startPairing();
                }}
              />
            </>
          ) : (
            <SettingsAction label="扫码配对" actionLabel="开始扫码配对" onPress={() => void startPairing()} />
          )
        ) : null}
      </SettingsCard>
      {error ? <Text style={{ color: theme.colors.statusDanger, marginTop: 8 }}>{error}</Text> : null}
    </SettingsSection>
  );
}

function PairingPanel({
  theme,
  spec,
  client,
  connectionId,
  onRefresh,
}: {
  theme: PluginScreenProps["theme"];
  spec: ChannelSpec;
  client: Pick<PluginClientContext, "rpc">;
  connectionId: string;
  onRefresh: () => void;
}) {
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    setStatus("等待扫码…");
    try {
      const result = await client.rpc(pairingStartRpc, { channel: spec.id, connectionId });
      setAttemptId(result.attemptId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    if (!attemptId) return;
    let alive = true;
    const poll = async () => {
      try {
        const result = await client.rpc(pairingPollRpc, { attemptId });
        if (!alive) return;
        setQr(result.qrDataUrl ?? null);
        setStatus(result.detail ? `${result.status}: ${result.detail}` : result.status);
        if (result.status === "ok" || result.status === "expired" || result.status === "failed") {
          setAttemptId(null);
          if (result.status === "ok") onRefresh();
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
        setAttemptId(null);
      }
    };
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [attemptId, client, onRefresh]);

  return (
    <SettingsSection title="扫码配对">
      <SettingsCard>
        <SettingsRow label="状态" hint={spec.hint}>
          <Text style={{ color: theme.colors.foreground }}>{status ?? "未开始"}</Text>
        </SettingsRow>
        {qr ? <Image source={{ uri: qr }} style={{ width: 220, height: 220, alignSelf: "center", margin: 12 }} /> : null}
        <SettingsAction label="配对" actionLabel={attemptId ? "重新扫码" : "开始配对"} onPress={() => void start()} />
      </SettingsCard>
      {error ? <Text style={{ color: theme.colors.statusDanger, marginTop: 8 }}>{error}</Text> : null}
    </SettingsSection>
  );
}

function ConnectionDetail({
  theme,
  client,
  view,
  choices,
  onRefresh,
  onBack,
  compact,
}: {
  theme: PluginScreenProps["theme"];
  client: Pick<PluginClientContext, "rpc">;
  view: ConnectionView;
  choices: Choices | null;
  onRefresh: () => void;
  onBack: () => void;
  compact: boolean;
}) {
  const config = view.config;
  const [name, setName] = useState(config.name);
  const [enabled, setEnabled] = useState(config.enabled);
  const [target, setTarget] = useState<Target | null>(config.target);
  const [bindings, setBindings] = useState<Record<string, Target>>(config.bindings as Record<string, Target>);
  const [policy, setPolicy] = useState<Policy>(config.policy);
  const [scope, setScope] = useState("default");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const spec = CHANNEL_LIST.find((entry) => entry.id === config.channel)!;
  const status = statusText(view);

  const save = async () => {
    setError(null);
    setNotice(null);
    try {
      await client.rpc(saveRpc, { id: config.id, revision: config.revision, name, enabled, target, bindings, policy });
      setNotice("已保存");
      onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const disconnect = async () => {
    try {
      await client.rpc(disconnectRpc, { id: config.id });
      onRefresh();
      onBack();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const test = async () => {
    setError(null);
    try {
      const result = await client.rpc(testRpc, { id: config.id });
      setNotice(result.ok ? "连接测试通过" : `连接测试失败：${result.detail ?? "未知原因"}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const currentTarget = scope === "default" ? target : bindings[scope] ?? null;
  const scopeOptions = [
    { value: "default", label: "默认去向" },
    ...view.conversations.map((conversation) => ({ value: conversation.key, label: conversation.title ?? conversation.key })),
  ];

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: compact ? 12 : 20, gap: 12 }}>
      <Pressable onPress={onBack}>
        <Text style={{ color: theme.colors.accent, marginBottom: 8 }}>‹ 返回 {spec.title}</Text>
      </Pressable>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: statusColor(theme, status.tone) }} />
        <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: 600 }}>{config.name}</Text>
        <Text style={{ color: theme.colors.foregroundMuted }}>{status.label}</Text>
      </View>
      {view.lastError ? <Text style={{ color: theme.colors.statusDanger }}>{view.lastError}</Text> : null}

      <SettingsSection title="连接">
        <SettingsCard>
          <SettingsInput label="名称" initialValue={config.name} onChangeText={setName} />
          <SettingsSwitch label="接收消息" value={enabled} onValueChange={setEnabled} />
          <SettingsAction label="测试" actionLabel="测试连接" onPress={() => void test()} />
          <SettingsAction label="保存" actionLabel="保存设置" onPress={() => void save()} />
          <SettingsAction label="删除" actionLabel="删除连接" onPress={() => void disconnect()} />
        </SettingsCard>
      </SettingsSection>

      {spec.pairing ? (
        <PairingPanel theme={theme} spec={spec} client={client} connectionId={config.id} onRefresh={onRefresh} />
      ) : null}

      <SettingsSection title="消息去向">
        <SettingsCard>
          <SettingsSelect
            label="配置范围"
            value={scope}
            options={scopeOptions}
            onValueChange={(value) => setScope(value)}
          />
          <RouteEditor
            theme={theme}
            choices={choices}
            target={currentTarget}
            onChange={(next) => {
              if (scope === "default") setTarget(next);
              else if (next) setBindings((current) => ({ ...current, [scope]: next }));
              else
                setBindings((current) => {
                  const { [scope]: _removed, ...rest } = current;
                  return rest;
                });
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="访问策略">
        <PolicyEditor policy={policy} onChange={setPolicy} />
      </SettingsSection>

      {view.pendingGroups.length ? (
        <SettingsSection title="待审批群组">
          <SettingsCard>
            {view.pendingGroups.map((group) => (
              <SettingsRow key={group.id} label={group.title ?? group.id}>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <SettingsAction
                    label="通过"
                    actionLabel="通过"
                    onPress={() => {
                      void client.rpc(reviewRpc, { id: config.id, chatId: group.id, approve: true }).then(onRefresh);
                    }}
                  />
                  <SettingsAction
                    label="拒绝"
                    actionLabel="拒绝"
                    onPress={() => {
                      void client.rpc(reviewRpc, { id: config.id, chatId: group.id, approve: false }).then(onRefresh);
                    }}
                  />
                </View>
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsSection>
      ) : null}

      {view.groups.length ? (
        <SettingsSection title="已接入群组">
          <SettingsCard>
            {view.groups.map((group) => (
              <SettingsRow key={group.id} label={group.title ?? group.id}>
                <SettingsAction
                  label="移出"
                  actionLabel="移出"
                  onPress={() => {
                    void client.rpc(revokeRpc, { id: config.id, chatId: group.id }).then(onRefresh);
                  }}
                />
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsSection>
      ) : null}

      {view.conversations.length ? (
        <SettingsSection title="当前关联会话">
          <SettingsCard>
            {view.conversations.map((conversation) => (
              <SettingsRow
                key={conversation.key}
                label={conversation.title ?? conversation.key}
                hint={conversation.agentId ?? undefined}
              >
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{conversation.key}</Text>
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsSection>
      ) : null}

      {notice ? <Text style={{ color: theme.colors.statusSuccess }}>{notice}</Text> : null}
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
    </ScrollView>
  );
}

function GlobalSettingsSection({ theme }: { theme: PluginScreenProps["theme"] }) {
  const settings = useSettings(imSettings);
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="通用设置">
        <SettingsCard>
          <Text style={{ color: theme.colors.foregroundMuted }}>
            {settings.status === "loading" ? "设置加载中…" : "设置不可用"}
          </Text>
        </SettingsCard>
      </SettingsSection>
    );
  }
  const { values, save, revision, saving } = settings;
  const numberField = (key: keyof typeof values, label: string, hint?: string) => (
    <SettingsInput
      key={key}
      label={label}
      hint={hint}
      initialValue={String(values[key])}
      onChangeText={(text) => {
        const parsed = Number(text);
        if (Number.isFinite(parsed)) void save({ ...values, [key]: parsed }, revision);
      }}
    />
  );
  return (
    <SettingsSection title="通用设置">
      <SettingsCard>
        {numberField("imageMaxDownloadMb", "图片原图上限 (MB)")}
        {numberField("imageMaxSingleMb", "模型输入单张上限 (MB)")}
        {numberField("imageMaxTotalMb", "模型输入总计上限 (MB)")}
        {numberField("imageMaxCount", "每条消息图片数上限")}
        {numberField("attachmentTtlHours", "附件保留 (小时，-1 永久)")}
        {numberField("deferTimeoutMinutes", "结果补发等待 (分钟)")}
        <SettingsSelect
          label="忙时行为"
          hint="新消息在任务运行中到达时的处理"
          value={values.busyMode}
          options={[
            { value: "queue", label: "排队" },
            { value: "steer", label: "插话" },
          ]}
          onValueChange={(value) => void save({ ...values, busyMode: value as "queue" | "steer" }, revision)}
        />
        {saving ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>保存中…</Text> : null}
      </SettingsCard>
    </SettingsSection>
  );
}

export function ImScreen({ theme, layout, client }: PluginScreenProps & { client: PluginClientContext }) {
  const [refreshToken, setRefreshToken] = useState(0);
  const result = useConnectionList(client, refreshToken);
  const [selection, setSelection] = useState<{ channel: string; connectionId: string } | null>(null);
  const [openChannel, setOpenChannel] = useState<string | null>(null);
  const [choices, setChoices] = useState<Choices | null>(null);

  useEffect(() => {
    void client
      .rpc(choicesRpc, {})
      .then(setChoices)
      .catch(() => {});
  }, [client]);

  const refresh = () => setRefreshToken((token) => token + 1);
  const compact = layout.compact;

  const selected = useMemo(() => {
    if (!selection || !result) return null;
    const channel = result.channels.find((entry) => entry.channel === selection.channel);
    return channel?.connections.find((view) => view.config.id === selection.connectionId) ?? null;
  }, [selection, result]);

  if (selected) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        <ConnectionDetail
          theme={theme}
          client={client}
          view={selected}
          choices={choices}
          onRefresh={refresh}
          onBack={() => setSelection(null)}
          compact={compact}
        />
      </View>
    );
  }

  if (openChannel) {
    const spec = CHANNEL_LIST.find((entry) => entry.id === openChannel)!;
    const connections = result?.channels.find((entry) => entry.channel === openChannel)?.connections ?? [];
    return (
      <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: compact ? 12 : 20, gap: 12 }}>
        <Pressable onPress={() => setOpenChannel(null)}>
          <Text style={{ color: theme.colors.accent }}>‹ 返回渠道列表</Text>
        </Pressable>
        <Text style={{ color: theme.colors.foreground, fontSize: 18 }}>{spec.title}</Text>
        <Text style={{ color: theme.colors.foregroundMuted }}>{spec.hint}</Text>
        {connections.length ? (
          <SettingsCard>
            {connections.map((view) => (
              <ConnectionsRow
                key={view.config.id}
                theme={theme}
                view={view}
                active={false}
                onPress={() => setSelection({ channel: openChannel, connectionId: view.config.id })}
              />
            ))}
          </SettingsCard>
        ) : null}
        <ConnectForm
          theme={theme}
          spec={spec}
          client={client}
          onDone={(id) => {
            refresh();
            setSelection({ channel: openChannel, connectionId: id });
          }}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: compact ? 12 : 20, gap: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 20 }}>IM 机器人</Text>
      <Text style={{ color: theme.colors.foregroundMuted }}>
        把飞书、微信、钉钉、企业微信、QQ、Slack、Telegram、Discord、WhatsApp、iMessage、Matrix 接入 Paseo agent。
      </Text>
      <SettingsCard>
        {CHANNEL_LIST.map((spec) => {
          const connections = result?.channels.find((entry) => entry.channel === spec.id)?.connections ?? [];
          const activeCount = connections.filter((view) => view.running).length;
          return (
            <Pressable
              key={spec.id}
              onPress={() => setOpenChannel(spec.id)}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 }}
            >
              <Text style={{ color: theme.colors.foreground, flex: 1 }}>{spec.title}</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                {connections.length ? `${activeCount}/${connections.length} 在线` : "未接入"}
              </Text>
            </Pressable>
          );
        })}
      </SettingsCard>
      <GlobalSettingsSection theme={theme} />
    </ScrollView>
  );
}

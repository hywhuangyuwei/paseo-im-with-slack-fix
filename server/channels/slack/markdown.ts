/** Slack mrkdwn rendering: standard markdown → mrkdwn conversion and
 * fence-aware chunking for chat.postMessage / chat.*Stream payloads.
 * Protocol facts ported from xmanrui/dsh-im (MIT). */

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
const HEADING_LINE = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function transformInline(line: string): string {
  // Inline code spans stay verbatim; only their surroundings are converted.
  return line
    .split(/(`[^`\n]*`)/)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        // [text](url) 与 ![alt](url) → <url|text>（Slack 文本不内联渲染图片）
        .replace(
          /!?\[([^\]\n]*)\]\(([^)\s]+)\)/g,
          (_match: string, label: string, url: string) =>
            label ? `<${url}|${label}>` : `<${url}>`,
        )
        // mrkdwn 用单标记：**粗体** → *粗体*，__斜体__ → _斜体_，~~删除~~ → ~删除~
        .replace(/\*\*([^\n*]+)\*\*/g, "*$1*")
        .replace(/__([^\n_]+)__/g, "_$1_")
        .replace(/~~([^\n~]+)~~/g, "~$1~");
    })
    .join("");
}

/** Convert common-markdown-ish text to Slack mrkdwn. *粗体*、_斜体_、`code`、
 * ```代码块```、<url|text> 链接按渠道语法输出，其余内容原样保留。 */
export function toMrkdwn(text: string): string {
  if (!text) return "";
  let fence = "";
  return text
    .split("\n")
    .map((line) => {
      const marker = FENCE_OPEN.exec(line)?.[1] ?? "";
      if (marker) {
        if (!fence) fence = marker;
        else if (line.trim() === marker) fence = "";
        return line; // 围栏行本身与其内部内容保持原样
      }
      if (fence) return line;
      const heading = HEADING_LINE.exec(line);
      if (heading) {
        const inner = transformInline(heading[1].trim()).replace(/^\*+|\*+$/g, "");
        return inner ? `*${inner}*` : line;
      }
      return transformInline(line);
    })
    .join("\n");
}

/** Fallback rendering when Slack rejects formatted text: drop emphasis
 * markers and flatten links to `label url`. */
export function toPlain(text: string): string {
  return text
    .replace(/!?\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) =>
      label ? `${label} ${url}` : url,
    )
    .replace(/(\*\*|__|~~)([^\n]+?)\1/g, "$2")
    .replace(/[*_~`]/g, "");
}

/**
 * Fence-aware chunking. Lines break at newline boundaries; an active code
 * fence is closed at the end of the current chunk and re-opened at the start
 * of the next one. A single line longer than the limit is hard-split.
 * Invariant: every chunk is at most `limit + 16` chars (the slack of the
 * closing/re-opening fence marker), far below Slack's 38k hard cap.
 */
export function splitMrkdwnChunks(text: string, limit: number): string[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("分块上限必须为正整数");
  }
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = "";
  let openFence = "";

  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = "";
  };
  const appendLine = (line: string) => {
    current = current.length === 0 ? line : `${current}\n${line}`;
  };

  for (const line of text.split("\n")) {
    const marker = FENCE_OPEN.exec(line)?.[1] ?? "";

    if (openFence && marker && line.trim() === marker) {
      // 关闭围栏
      appendLine(line);
      openFence = "";
      continue;
    }
    if (!openFence && marker) {
      // 开启围栏；若当前块放不下则先开新块
      if (current.length + 1 + line.length > limit) flush();
      appendLine(line);
      openFence = marker;
      continue;
    }
    if (current.length + 1 + line.length <= limit) {
      appendLine(line);
      continue;
    }
    if (line.length <= limit) {
      // 在行边界断开；活动围栏在本块末尾闭合、下一块开头重开
      if (openFence) {
        current = `${current}\n${openFence}`;
        flush();
        current = openFence;
        appendLine(line);
      } else {
        flush();
        appendLine(line);
      }
      continue;
    }
    // 单行超过上限：硬切分，围栏逐块闭合/重开
    flush();
    if (openFence) current = openFence;
    for (let offset = 0; offset < line.length; ) {
      const room = Math.max(1, openFence ? limit - openFence.length - 1 : limit);
      const piece = line.slice(offset, offset + room);
      offset += piece.length;
      if (current.length > 0 && current.length + 1 + piece.length > limit) {
        if (openFence) current = `${current}\n${openFence}`;
        flush();
        if (openFence) current = openFence;
      }
      appendLine(piece);
    }
  }
  flush();
  return chunks;
}

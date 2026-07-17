const TELEGRAM_API = "https://api.telegram.org";

async function tgApi(botToken: string, method: string, params: Record<string, any> = {}): Promise<any> {
  const url = `${TELEGRAM_API}/bot${botToken}/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

async function sendToTelegram(botToken: string, chatId: number, text: string) {
  const maxLen = 4000;
  for (let i = 0; i < text.length; i += maxLen) {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: text.slice(i, i + maxLen),
    });
  }
}

async function downloadFromTelegram(botToken: string, fileId: string): Promise<{ data: ArrayBuffer; name: string }> {
  const fileInfo = await tgApi(botToken, "getFile", { file_id: fileId });
  const filePath = fileInfo.file_path;
  const fileUrl = `${TELEGRAM_API}/file/bot${botToken}/${filePath}`;
  const resp = await fetch(fileUrl);
  if (!resp.ok) throw new Error(`Download failed: HTTP ${resp.status}`);
  const arrayBuf = await resp.arrayBuffer();
  const name = filePath.split("/").pop() || "document";
  return { data: arrayBuf, name };
}

export async function handleTelegramWebhook(
  reqBody: any,
  botToken: string,
  aporixApiUrl: string
) {
  if (!botToken) {
    console.error("[telegram] BOT_TOKEN not configured");
    return;
  }

  const message = reqBody.message || reqBody.edited_message;
  if (!message) return;

  const chatId = message.chat.id;
  const doc = message.document;
  const text = message.text;
  const reply = (msg: string) => sendToTelegram(botToken, chatId, msg);

  // Only handle documents (PDF, TXT files)
  if (doc) {
    await reply("Downloading your document...");

    try {
      const { data: fileData, name: fileName } = await downloadFromTelegram(botToken, doc.file_id);

      await reply("Processing with Aporix...");

      const form = new FormData();
      form.append("file", new Blob([fileData], { type: "application/octet-stream" }), fileName);
      form.append("goal", "Optimize this document for clarity and conciseness while preserving all legal terms, obligations, and conditions");

      const apiResp = await fetch(aporixApiUrl, { method: "POST", body: form });
      const data = await apiResp.json();

      if (!data.success) {
        await reply(`Aporix error: ${data.error || "Unknown error"}`);
        return;
      }

      const pct = data.tokenStats?.percentSaved ?? 0;
      const conf = data.trustLayer?.confidenceScore
        ? Math.round(data.trustLayer.confidenceScore * 100) + "%"
        : "?";
      const savings = data.costAnalysis?.savings?.toFixed(4) ?? "?";
      const removed = data.removedSummary ?? "";
      const preserved = data.trustLayer?.preservedSummary ?? "";

      const replyMsg =
`TOKEN SAVINGS: ${data.tokenStats?.originalTokens?.toLocaleString() ?? "?"} -> ${data.tokenStats?.optimizedTokens?.toLocaleString() ?? "?"} (${pct}% reduction)
COST SAVED: $${savings}
CONFIDENCE: ${conf}

REMOVED: ${removed}
PRESERVED: ${preserved}

--- OPTIMIZED TEXT ---

${data.optimizedText}`;

      await reply(replyMsg);
    } catch (err: any) {
      await reply(`Error: ${err.message || "Something went wrong"}`);
    }
    return;
  }

  // Text message handling
  if (text) {
    if (text === "/start" || text === "/help") {
      await reply(
        `Send me a PDF or document file and I will optimize it using Aporix AI, returning token savings stats and the optimized text.`
      );
      return;
    }

    // Long text = treat as document
    if (text.length > 500) {
      await reply("Processing text with Aporix...");
      try {
        const form = new FormData();
        form.append("file", new Blob([new TextEncoder().encode(text)], { type: "text/plain" }), "document.txt");
        form.append("goal", "Optimize this document for clarity and conciseness while preserving all legal terms, obligations, and conditions");

        const apiResp = await fetch(aporixApiUrl, { method: "POST", body: form });
        const data = await apiResp.json();

        if (!data.success) {
          await reply(`Aporix error: ${data.error || "Unknown error"}`);
          return;
        }

        const pct = data.tokenStats?.percentSaved ?? 0;
        const conf = data.trustLayer?.confidenceScore
          ? Math.round(data.trustLayer.confidenceScore * 100) + "%"
          : "?";
        const savings = data.costAnalysis?.savings?.toFixed(4) ?? "?";

        const replyMsg =
`TOKEN SAVINGS: ${data.tokenStats?.originalTokens?.toLocaleString() ?? "?"} -> ${data.tokenStats?.optimizedTokens?.toLocaleString() ?? "?"} (${pct}% reduction)
COST SAVED: $${savings}
CONFIDENCE: ${conf}

REMOVED: ${data.removedSummary ?? ""}
PRESERVED: ${data.trustLayer?.preservedSummary ?? ""}

--- OPTIMIZED TEXT ---

${data.optimizedText}`;

        await reply(replyMsg);
      } catch (err: any) {
        await reply(`Error: ${err.message || "Something went wrong"}`);
      }
    }
  }
}

import https from "node:https";

const TELEGRAM_API = "https://api.telegram.org";

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    }).on("error", reject);
  });
}

function postJson(url: string, body: unknown): Promise<string> {
  const json = JSON.stringify(body);
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      u,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": json.length.toString(),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.write(json);
    req.end();
  });
}

async function sendToTelegram(
  botToken: string,
  chatId: number,
  text: string
) {
  await postJson(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  });
}

async function getFileUrl(
  botToken: string,
  fileId: string
): Promise<string> {
  const resp = await fetchUrl(
    `${TELEGRAM_API}/bot${botToken}/getFile?file_id=${fileId}`
  );
  const data = JSON.parse(resp);
  if (!data.ok || !data.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${resp}`);
  }
  return `${TELEGRAM_API}/file/bot${botToken}/${data.result.file_path}`;
}

function postFormData(
  url: string,
  fields: Record<string, string>,
  fileField: string,
  fileName: string,
  fileBuffer: Buffer
): Promise<string> {
  const boundary = `----${Date.now()}`;
  const u = new URL(url);

  const parts: Buffer[] = [];
  for (const [key, val] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const req = https.request(
      u,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length.toString(),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function downloadFile(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
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

  // Handle document (PDF, TXT, etc.)
  if (doc) {
    await sendToTelegram(botToken, chatId, "📄 Downloading your document...");

    try {
      const fileUrl = await getFileUrl(botToken, doc.file_id);
      const fileBuffer = await downloadFile(fileUrl);
      const fileName = doc.file_name || "document";

      await sendToTelegram(botToken, chatId, "⚙️ Processing with Aporix...");

      const apiResp = await postFormData(
        aporixApiUrl,
        { goal: "Optimize this document for clarity and conciseness while preserving all legal terms" },
        "file",
        fileName,
        fileBuffer
      );

      const data = JSON.parse(apiResp);
      if (!data.success) {
        await sendToTelegram(
          botToken,
          chatId,
          `❌ Aporix error: ${data.error || "Unknown error"}`
        );
        return;
      }

      const pct = data.tokenStats?.percentSaved ?? 0;
      const conf = data.trustLayer?.confidenceScore
        ? Math.round(data.trustLayer.confidenceScore * 100) + "%"
        : "?";
      const savings = data.costAnalysis?.savings?.toFixed(4) ?? "?";
      const removed = data.removedSummary ?? "";
      const preserved = data.trustLayer?.preservedSummary ?? "";

      const reply =
`📊 *Token savings:* ${data.tokenStats?.originalTokens?.toLocaleString() ?? "?"} → ${data.tokenStats?.optimizedTokens?.toLocaleString() ?? "?"} (${pct}% reduction)
💰 *Cost saved:* $${savings}
✅ *Confidence:* ${conf}

🗑 *Removed:* ${removed}
📋 *Preserved:* ${preserved}

--- *Optimized text* ---

${data.optimizedText}`;

      // Telegram has 4096 char limit per message, split if needed
      const maxLen = 4000;
      for (let i = 0; i < reply.length; i += maxLen) {
        await sendToTelegram(botToken, chatId, reply.slice(i, i + maxLen));
      }
    } catch (err: any) {
      await sendToTelegram(
        botToken,
        chatId,
        `❌ Error: ${err.message || "Something went wrong"}`
      );
    }
    return;
  }

  // Handle text message
  if (text) {
    const goalMatch = text.match(/\/optimize(?:\s+(.+))?/s);
    if (goalMatch) {
      const customGoal = goalMatch[1]?.trim() || "Optimize this document for clarity and conciseness while preserving all legal terms";
      await sendToTelegram(botToken, chatId, "⚙️ Processing with Aporix... Please send the document text.");

      // For text messages, we can't receive follow-up easily in a webhook.
      // The user should upload a file instead.
      await sendToTelegram(
        botToken,
        chatId,
        "ℹ️ Please upload a PDF or text file for optimization, or text after the /optimize command is not supported yet in this mode."
      );
      return;
    }

    // Default: check if message looks like document text (long)
    if (text.length > 500) {
      // Call Aporix API as plain text file
      await sendToTelegram(botToken, chatId, "⚙️ Processing text with Aporix...");

      try {
        const apiResp = await postFormData(
          aporixApiUrl,
          { goal: "Optimize this document for clarity and conciseness while preserving all legal terms" },
          "file",
          "document.txt",
          Buffer.from(text, "utf-8")
        );

        const data = JSON.parse(apiResp);
        if (!data.success) {
          await sendToTelegram(
            botToken,
            chatId,
            `❌ Aporix error: ${data.error || "Unknown error"}`
          );
          return;
        }

        const pct = data.tokenStats?.percentSaved ?? 0;
        const conf = data.trustLayer?.confidenceScore
          ? Math.round(data.trustLayer.confidenceScore * 100) + "%"
          : "?";
        const savings = data.costAnalysis?.savings?.toFixed(4) ?? "?";

        const reply =
`📊 *Token savings:* ${data.tokenStats?.originalTokens?.toLocaleString() ?? "?"} → ${data.tokenStats?.optimizedTokens?.toLocaleString() ?? "?"} (${pct}% reduction)
💰 *Cost saved:* $${savings}
✅ *Confidence:* ${conf}

🗑 *Removed:* ${data.removedSummary ?? ""}
📋 *Preserved:* ${data.trustLayer?.preservedSummary ?? ""}

--- *Optimized text* ---

${data.optimizedText}`;

        const maxLen = 4000;
        for (let i = 0; i < reply.length; i += maxLen) {
          await sendToTelegram(botToken, chatId, reply.slice(i, i + maxLen));
        }
      } catch (err: any) {
        await sendToTelegram(
          botToken,
          chatId,
          `❌ Error: ${err.message || "Something went wrong"}`
        );
      }
      return;
    }

    // Help text
    if (text === "/start" || text === "/help") {
      await sendToTelegram(
        botToken,
        chatId,
        `🤖 *Aporix Bot*

Send me a PDF or text document and I'll optimize it using Aporix AI.

*Commands:*
/start - Show this message
/help - Show this message

*Usage:*
Just upload a PDF or TXT file and I'll optimize it automatically.`
      );
    }
  }
}

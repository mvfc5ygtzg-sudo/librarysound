/**
 * DJ Library — Telegram bot server (Cloudflare Worker).
 * Send audio files to the bot → they appear in the mini app for the same Telegram user.
 * Files stay in Telegram; this worker only keeps a small list per user in KV.
 *
 * Bindings (Cloudflare dashboard → Worker → Settings):
 *   BOT_TOKEN  — secret, the token from @BotFather
 *   TRACKS     — KV namespace
 *   FILES      — (optional) R2 bucket for big WAV/FLAC uploaded from the app
 *   APP_URL    — (optional) mini app URL, default below
 */
const DEFAULT_APP = "https://mvfc5ygtzg-sudo.github.io/librarysound/";
const AUDIO_EXT = /\.(mp3|wav|aiff?|flac|m4a|aac|ogg|alac)$/i;
const BOT_API_DOWNLOAD_LIMIT = 20 * 1024 * 1024; // Telegram Bot API can serve files up to 20 MB

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256hex(s) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range, X-Track-Meta",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });

async function tg(env, method, params) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params || {}),
  });
  return r.json();
}

/** Validates Telegram WebApp initData; returns the user object or null. */
async function verifyInitData(initData, token) {
  if (!initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash"); if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac("WebAppData", token);
  const sig = hex(await hmac(secret, dcs));
  if (sig !== hash) return null;
  const age = Date.now() / 1000 - Number(p.get("auth_date") || 0);
  if (!(age >= -300 && age < 30 * 86400)) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch { return null; }
}

const libKey = (uid) => `lib:${uid}`;
async function getLib(env, uid) { return (await env.TRACKS.get(libKey(uid), "json")) || []; }
async function putLib(env, uid, lib) { await env.TRACKS.put(libKey(uid), JSON.stringify(lib)); }

function fileFromMessage(m) {
  const a = m.audio || m.document || m.voice || null;
  if (!a) return null;
  const name = a.file_name || (m.audio ? `${m.audio.performer ? m.audio.performer + " - " : ""}${m.audio.title || "track"}.mp3` : "track");
  const isAudio = !!m.audio || (a.mime_type || "").startsWith("audio/") || AUDIO_EXT.test(name);
  if (!isAudio) return { notAudio: true, name };
  return {
    id: a.file_unique_id, file_id: a.file_id, name, size: a.file_size || 0, mime: a.mime_type || "",
    performer: (m.audio && m.audio.performer) || "", title: (m.audio && m.audio.title) || "",
    duration: (m.audio && m.audio.duration) || 0, date: m.date || Math.floor(Date.now() / 1000),
  };
}

async function handleUpdate(env, update, appUrl) {
  const m = update.message || update.channel_post; if (!m || !m.from) return;
  const uid = m.from.id, chat = m.chat.id;
  const text = (m.text || "").trim();
  const openBtn = { reply_markup: { inline_keyboard: [[{ text: "🎧 Открыть библиотеку", web_app: { url: appUrl } }]] } };

  if (text.startsWith("/start")) {
    await tg(env, "sendMessage", { chat_id: chat, text: "Привет! Отправляй сюда треки (как файлы или аудио) — они сразу появятся в приложении.\n\nПапка: напиши её в подписи к файлу, например «House». Или отправь /folder House — и все следующие треки попадут туда.\n\nWAV и FLAC больше 20 МБ бот передать не может — их загружай в приложении: «Добавить» → «Загрузить WAV / FLAC».", ...openBtn });
    return;
  }
  if (text.startsWith("/folder")) {
    const f = text.replace(/^\/folder(@\w+)?/, "").trim().slice(0, 40);
    await env.TRACKS.put(`folder:${uid}`, f);
    await tg(env, "sendMessage", { chat_id: chat, text: f ? `📁 Следующие треки пойдут в папку «${f}».` : "📁 Папка сброшена: треки пойдут без папки." });
    return;
  }
  const file = fileFromMessage(m);
  if (!file) return;
  if (file.notAudio) { await tg(env, "sendMessage", { chat_id: chat, text: `«${file.name}» — это не аудиофайл. Отправь MP3, WAV, AIFF, FLAC или M4A.` }); return; }
  const caption = (m.caption || "").split("\n")[0].replace(/^#/, "").trim().slice(0, 40);
  file.folder = caption || (await env.TRACKS.get(`folder:${uid}`)) || "";
  const lib = await getLib(env, uid);
  const i = lib.findIndex((x) => x.id === file.id);
  if (i >= 0) lib[i] = { ...lib[i], ...file }; else lib.push(file);
  await putLib(env, uid, lib);
  let msg = `✅ «${file.name}» добавлен${file.folder ? ` в папку «${file.folder}»` : ""}.`;
  if (file.size > BOT_API_DOWNLOAD_LIMIT) msg += `\n⚠️ Файл больше 20 МБ — Telegram не даёт ботам скачивать такие файлы. Чтобы слушать его в полном качестве, загрузи его в приложении: «Добавить» → «Загрузить WAV / FLAC».`;
  await tg(env, "sendMessage", { chat_id: chat, text: msg, reply_to_message_id: m.message_id, ...openBtn });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const appUrl = env.APP_URL || DEFAULT_APP;
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (!env.BOT_TOKEN || !env.TRACKS) return json({ error: "Не настроено: добавь секрет BOT_TOKEN и KV TRACKS" }, 500);
    const secret = (await sha256hex("webhook:" + env.BOT_TOKEN)).slice(0, 32);

    // one-time setup: open https://<worker>/setup in a browser
    if (url.pathname === "/setup") {
      const hook = await tg(env, "setWebhook", { url: `${url.origin}/webhook`, secret_token: secret, allowed_updates: ["message"], max_connections: 1, drop_pending_updates: false });
      const menu = await tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "Библиотека", web_app: { url: appUrl } } });
      await tg(env, "setMyCommands", { commands: [{ command: "start", description: "Как добавлять треки" }, { command: "folder", description: "Папка для следующих треков" }] });
      const ok = hook.ok && menu.ok;
      return new Response(`<meta charset="utf-8"><body style="font:18px -apple-system,sans-serif;background:#0B0C0F;color:#F2F3F5;padding:40px"><h2>${ok ? "✅ Бот настроен" : "❌ Ошибка"}</h2><p>${ok ? "Отправляй треки боту — они появятся в приложении." : "Проверь BOT_TOKEN. Ответ Telegram: " + JSON.stringify(hook.description || menu.description)}</p></body>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/webhook" && req.method === "POST") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== secret) return new Response("forbidden", { status: 403 });
      try { await handleUpdate(env, await req.json(), appUrl); } catch (e) { console.log("update error", e && e.stack); }
      return new Response("ok");
    }

    if (url.pathname.startsWith("/api/")) {
      const user = await verifyInitData(url.searchParams.get("auth") || "", env.BOT_TOKEN);
      if (!user) return json({ error: "Открой приложение из Telegram-бота" }, 401);
      const uid = user.id;

      if (url.pathname === "/api/tracks" && req.method === "GET") {
        const lib = await getLib(env, uid);
        return json({ upload: !!env.FILES, tracks: lib.map(({ file_id, r2, ...t }) => ({ ...t, stored: !!r2, playable: !!r2 || t.size <= BOT_API_DOWNLOAD_LIMIT })) });
      }
      const mDel = url.pathname.match(/^\/api\/track\/([\w-]+)$/);
      if (mDel && req.method === "DELETE") {
        const lib = await getLib(env, uid); const t = lib.find((x) => x.id === mDel[1]);
        if (t && t.r2 && env.FILES) { try { await env.FILES.delete(t.r2); } catch (e) {} }
        await putLib(env, uid, lib.filter((x) => x.id !== mDel[1]));
        return json({ ok: true });
      }
      // big WAV/FLAC: multipart upload straight from the app into R2
      if (url.pathname.startsWith("/api/upload/")) {
        if (!env.FILES) return json({ error: "Хранилище для WAV ещё не подключено" }, 501);
        const step = url.pathname.slice(12);
        if (step === "init" && req.method === "POST") {
          const b = await req.json(); const name = String(b.name || "track").slice(0, 200);
          if (!AUDIO_EXT.test(name)) return json({ error: "Это не аудиофайл" }, 400);
          const key = `u${uid}/${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}/${name}`;
          const mp = await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: b.mime || "application/octet-stream" } });
          return json({ key, uploadId: mp.uploadId });
        }
        const key = url.searchParams.get("key") || "", uploadId = url.searchParams.get("uploadId") || "";
        if (!key.startsWith(`u${uid}/`)) return json({ error: "forbidden" }, 403);
        const mp = env.FILES.resumeMultipartUpload(key, uploadId);
        if (step === "part" && req.method === "PUT") {
          const part = await mp.uploadPart(Number(url.searchParams.get("part")), await req.arrayBuffer());
          return json({ partNumber: part.partNumber, etag: part.etag });
        }
        if (step === "complete" && req.method === "POST") {
          const b = await req.json();
          const obj = await mp.complete(b.parts);
          const name = key.split("/").pop();
          const t = { id: "r" + key.split("/")[1].replace(/[^\w-]/g, ""), r2: key, name, size: obj.size, mime: b.mime || "", performer: "", title: "", duration: 0, date: Math.floor(Date.now() / 1000), folder: String(b.folder || "").slice(0, 40) };
          const lib = await getLib(env, uid); lib.push(t); await putLib(env, uid, lib);
          return json({ ok: true, id: t.id });
        }
        if (step === "abort" && req.method === "POST") { try { await mp.abort(); } catch (e) {} return json({ ok: true }); }
        return json({ error: "not found" }, 404);
      }
      const mFile = url.pathname.match(/^\/api\/file\/([\w-]+)$/);
      if (mFile && (req.method === "GET" || req.method === "HEAD")) {
        const t = (await getLib(env, uid)).find((x) => x.id === mFile[1]);
        if (!t) return json({ error: "Трек не найден" }, 404);
        if (t.r2) {
          if (!env.FILES) return json({ error: "Хранилище не подключено" }, 501);
          const range = req.headers.get("Range");
          const obj = req.method === "HEAD" ? await env.FILES.head(t.r2) : await env.FILES.get(t.r2, range ? { range: req.headers } : {});
          if (!obj) return json({ error: "Файл не найден в хранилище" }, 404);
          const h = new Headers(cors);
          h.set("Content-Type", t.mime || obj.httpMetadata?.contentType || "audio/wav"); h.set("Accept-Ranges", "bytes"); h.set("Cache-Control", "private, max-age=3600");
          let status = 200;
          if (range && obj.range) {
            const off = obj.range.offset ?? (obj.size - obj.range.suffix), len = obj.range.length ?? (obj.size - off);
            h.set("Content-Range", `bytes ${off}-${off + len - 1}/${obj.size}`); h.set("Content-Length", String(len)); status = 206;
          } else h.set("Content-Length", String(obj.size));
          return new Response(req.method === "HEAD" ? null : obj.body, { status, headers: h });
        }
        if (t.size > BOT_API_DOWNLOAD_LIMIT) return json({ error: "Файл больше 20 МБ — Telegram не отдаёт такие файлы ботам" }, 413);
        const f = await tg(env, "getFile", { file_id: t.file_id });
        if (!f.ok) return json({ error: "Telegram не отдал файл: " + (f.description || "") }, 502);
        const headers = {}; const range = req.headers.get("Range"); if (range) headers.Range = range;
        const up = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.result.file_path}`, { headers });
        const h = new Headers(cors);
        for (const k of ["Content-Length", "Content-Range", "Accept-Ranges"]) { const v = up.headers.get(k); if (v) h.set(k, v); }
        h.set("Content-Type", t.mime || "audio/mpeg"); h.set("Cache-Control", "private, max-age=3600");
        return new Response(req.method === "HEAD" ? null : up.body, { status: up.status, headers: h });
      }
      return json({ error: "not found" }, 404);
    }
    return new Response("DJ Library bot server works. Open /setup once to connect the bot.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },
};
export { verifyInitData, handleUpdate };

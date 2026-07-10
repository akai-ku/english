"use strict";

// ---------------------------------------------------------------------------
// データ管理
// ---------------------------------------------------------------------------

const STORAGE_KEY = "english.cards.v1";

// 間隔反復のレベルごとの復習間隔(日)。正解するたびにレベルが上がる
const INTERVALS = [0, 1, 3, 7, 14, 30, 60];
const MAX_LEVEL = INTERVALS.length - 1;

function loadCards() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

const DIRTY_KEY = "english.dirty.v1";

function saveCards() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
  // スプレッドシートにまだ保存していない変更がある印
  localStorage.setItem(DIRTY_KEY, "1");
}

function isDirty() {
  return localStorage.getItem(DIRTY_KEY) === "1";
}

function clearDirty() {
  localStorage.removeItem(DIRTY_KEY);
}

/** ローカル時刻での YYYY-MM-DD 文字列 */
function toLocalDateStr(date = new Date()) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return toLocalDateStr(d);
}

let cards = loadCards();
let currentFilter = "due";

function createCard(fields) {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
    en: "",
    ja: "",
    addedAt: new Date().toISOString(),
    level: 0,
    dueAt: toLocalDateStr(), // 今日からすぐ復習対象
    reviews: 0,
    lapses: 0,
    ...fields,
  };
}

function addCard(fields) {
  const card = createCard(fields);
  cards.unshift(card);
  saveCards();
  return card;
}

function updateCard(id, fields) {
  const card = cards.find((c) => c.id === id);
  if (!card) return;
  Object.assign(card, fields);
  saveCards();
  render();
}

function deleteCard(id) {
  cards = cards.filter((c) => c.id !== id);
  saveCards();
  render();
}

function dueCards() {
  const today = toLocalDateStr();
  return cards.filter((c) => c.dueAt <= today);
}

// ---------------------------------------------------------------------------
// テキストユーティリティ
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/** チャンク区切りの / と // を色付きで表示するHTMLに変換 */
function chunkHtml(text) {
  let h = escapeHtml(text);
  h = h.replaceAll("//", "\u0000");
  h = h.replaceAll("/", '<span class="sep sep1">/</span>');
  h = h.replaceAll("\u0000", '<span class="sep sep2">//</span>');
  return h;
}

/** 読み上げ・発音判定用に、話者ラベル(A:)とスラッシュを取り除いた英文にする */
function speakableEnglish(en) {
  return en
    .replace(/^[A-D]\s*[::]\s*/, "")
    .replace(/\/+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 話者ラベル(A:)を取り出す。無ければ空文字 */
function speakerLabel(text) {
  const m = text.match(/^\s*([A-D])\s*[::]\s*/);
  return m ? m[1] + ": " : "";
}

/** / と // でチャンクに分割する(頭ごなし訳・チャンク音読で使用)。話者ラベルは除く */
function splitChunks(text) {
  const body = text.replace(/^\s*[A-D]\s*[::]\s*/, "");
  return body
    .split(/\s*\/\/?\s*/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * 英文と和文をチャンクごとに対応づける(スラッシュリーディング教材は
 * / // の位置が英日で揃っている前提)。数が合わないときは null を返す
 */
function chunkPairs(en, ja) {
  const enChunks = splitChunks(en);
  const jaChunks = splitChunks(ja);
  if (!ja || enChunks.length !== jaChunks.length || enChunks.length < 2) {
    return null;
  }
  return enChunks.map((e, i) => ({ en: e, ja: jaChunks[i] }));
}

/** 発音判定用に英文を単語の配列へ */
function tokenizeEnglish(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// OCRテキストの整形
// (サンプル教材: 「A: Good morning, / Mr. Tanaka. // Can I ask you / ...」形式)
// ---------------------------------------------------------------------------

/** 行の集まりを A:/B: の発話ごとに1行へまとめる。会話形式でなければ文単位に分割 */
function groupIntoTurns(rawText) {
  const lines = rawText
    .split("\n")
    .map((l) => l.trim())
    // 空行と、ページ端の行番号(5, 10, 15 …)だけの行を除く
    .filter((l) => l && !/^\d{1,3}$/.test(l));

  const isTurnStart = (l) => /^[A-DA-D]\s*[::]/.test(l);

  if (lines.some(isTurnStart)) {
    const turns = [];
    for (const line of lines) {
      if (isTurnStart(line) || turns.length === 0) {
        turns.push(line);
      } else {
        turns[turns.length - 1] += " " + line;
      }
    }
    return turns;
  }

  // 会話形式でない場合: つなげてから文末(. ! ?)で区切る
  const joined = lines.join(" ").replace(/\s+/g, " ");
  const sentences = joined.match(/[^.!?]+[.!?]+["”’]?/g);
  return sentences ? sentences.map((s) => s.trim()) : joined ? [joined] : [];
}

function cleanOcrEnglish(raw) {
  const text = raw
    .replace(/-\n/g, "") // 行末ハイフンの単語をつなげる
    .replace(/[|]/g, "/") // OCRが / を | と誤認することがある
    .replace(/[ \t]+/g, " ");
  return groupIntoTurns(text)
    .map((t) =>
      t
        .replace(/\/\s*\//g, "\u0000") // // をいったん退避
        .replace(/\s*\/\s*/g, " / ")
        .replace(/\s*\u0000\s*/g, " // ")
        .replace(/\s+/g, " ")
        .replace(/([.!?])\s+\d{1,2}$/, "$1") // 文末に残ったページ余白の行番号を除く
        .trim()
    )
    .join("\n");
}

/** 日本語文字のあいだに入ったOCR由来の空白を除く */
function removeJaSpaces(s) {
  let prev;
  do {
    prev = s;
    s = s.replace(/([^\x00-\x7F]) +(?=[^\x00-\x7F])/g, "$1");
  } while (s !== prev);
  return s;
}

function cleanOcrJapanese(raw) {
  const text = raw.replace(/[|]/g, "/").replace(/[ \t]+/g, " ");
  return groupIntoTurns(text)
    .map((t) => removeJaSpaces(t).trim())
    .join("\n");
}

// ---------------------------------------------------------------------------
// 自動翻訳 (MyMemory API: 無料・キー不要)
// ---------------------------------------------------------------------------

async function translateEnToJa(text) {
  const query = speakableEnglish(text);
  if (!query) return "";
  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(query)}&langpair=en|ja`
    );
    if (!res.ok) return "";
    const data = await res.json();
    const t = data?.responseData?.translatedText || "";
    if (!t || /MYMEMORY WARNING/i.test(t)) return "";
    return t;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// トースト
// ---------------------------------------------------------------------------

const toastEl = document.getElementById("toast");
let toastTimer = null;

function showToast(text, duration = 4000) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), duration);
}

// ---------------------------------------------------------------------------
// 写真読み取り (Tesseract.js をCDNから遅延読み込み)
// ---------------------------------------------------------------------------

const OCR_MAX_DIM = 2000; // 大きすぎる写真は縮小して読み取りを速くする

let tesseractPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (tesseractPromise) return tesseractPromise;
  tesseractPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    script.onload = () => resolve();
    script.onerror = () => {
      tesseractPromise = null;
      reject(new Error("failed to load tesseract.js"));
    };
    document.head.appendChild(script);
  });
  return tesseractPromise;
}

async function fileToCanvas(file) {
  // createImageBitmap はEXIFの向きを反映してくれる
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, OCR_MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

function rotateCanvas(canvas) {
  const rotated = document.createElement("canvas");
  rotated.width = canvas.height;
  rotated.height = canvas.width;
  const ctx = rotated.getContext("2d");
  ctx.translate(rotated.width / 2, rotated.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return rotated;
}

/**
 * 写真読み取りのセクション(英語/日本語)をひとつ組み立てる。
 * 写真選択 → プレビュー(回転可) → OCR → テキストエリアへ、の流れを共通化
 */
function setupOcrSection({ lang, cameraId, fileId, rotateId, ocrBtnId, previewWrapId, progressId, progressFillId, statusId, textareaId, clean }) {
  const rotateBtn = document.getElementById(rotateId);
  const ocrBtn = document.getElementById(ocrBtnId);
  const previewWrap = document.getElementById(previewWrapId);
  const progress = document.getElementById(progressId);
  const progressFill = document.getElementById(progressFillId);
  const status = document.getElementById(statusId);
  const textarea = document.getElementById(textareaId);

  let canvas = null;

  async function onPick(file) {
    if (!file) return;
    try {
      canvas = await fileToCanvas(file);
    } catch {
      showToast("写真を読み込めませんでした。別の写真で試してください。", 6000);
      return;
    }
    showPreview();
    rotateBtn.classList.remove("hidden");
    ocrBtn.classList.remove("hidden");
    status.textContent = "文字が横向きなら「↻ 回転」で直してから「🔍 読み取る」を押してください。";
    progress.classList.remove("hidden");
    progressFill.style.width = "0%";
  }

  function showPreview() {
    previewWrap.innerHTML = "";
    previewWrap.appendChild(canvas);
    previewWrap.classList.remove("hidden");
  }

  rotateBtn.addEventListener("click", () => {
    if (!canvas) return;
    canvas = rotateCanvas(canvas);
    showPreview();
  });

  ocrBtn.addEventListener("click", async () => {
    if (!canvas) return;
    ocrBtn.disabled = true;
    rotateBtn.disabled = true;
    progress.classList.remove("hidden");
    status.textContent = "読み取りの準備をしています…(初回は少し時間がかかります)";
    try {
      await loadTesseract();
      const result = await Tesseract.recognize(canvas, lang, {
        logger: (m) => {
          if (m.status === "recognizing text") {
            progressFill.style.width = `${Math.round(m.progress * 100)}%`;
            status.textContent = `文字を読み取っています… ${Math.round(m.progress * 100)}%`;
          }
        },
      });
      const cleaned = clean(result.data.text || "");
      if (!cleaned) {
        status.textContent = "文字を読み取れませんでした。写真の向きや明るさを変えて試してください。";
      } else {
        textarea.value = cleaned;
        status.textContent = "読み取りました。下のテキストを確認して、必要なら直してください。";
      }
    } catch {
      status.textContent = "読み取りに失敗しました。通信環境を確認してもう一度試してください。";
    } finally {
      ocrBtn.disabled = false;
      rotateBtn.disabled = false;
    }
  });

  for (const inputId of [cameraId, fileId]) {
    document.getElementById(inputId).addEventListener("change", (e) => {
      onPick(e.target.files[0]);
      e.target.value = ""; // 同じ写真をもう一度選べるように
    });
  }
}

setupOcrSection({
  lang: "eng",
  cameraId: "photo-en-camera",
  fileId: "photo-en-file",
  rotateId: "rotate-en-btn",
  ocrBtnId: "ocr-en-btn",
  previewWrapId: "preview-en-wrap",
  progressId: "progress-en",
  progressFillId: "progress-en-fill",
  statusId: "status-en",
  textareaId: "ocr-en-text",
  clean: cleanOcrEnglish,
});

setupOcrSection({
  lang: "jpn",
  cameraId: "photo-ja-camera",
  fileId: "photo-ja-file",
  rotateId: "rotate-ja-btn",
  ocrBtnId: "ocr-ja-btn",
  previewWrapId: "preview-ja-wrap",
  progressId: "progress-ja",
  progressFillId: "progress-ja-fill",
  statusId: "status-ja",
  textareaId: "ocr-ja-text",
  clean: cleanOcrJapanese,
});

// ---------------------------------------------------------------------------
// 写真ダイアログ: 読み取った英文・日本語訳をカードとして登録
// ---------------------------------------------------------------------------

const photoDialog = document.getElementById("photo-dialog");
const ocrRegisterBtn = document.getElementById("ocr-register-btn");

document.getElementById("photo-add-btn").addEventListener("click", () => {
  photoDialog.showModal();
});
document.getElementById("photo-close").addEventListener("click", () => photoDialog.close());

ocrRegisterBtn.addEventListener("click", async () => {
  const enLines = document
    .getElementById("ocr-en-text")
    .value.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const jaLines = document
    .getElementById("ocr-ja-text")
    .value.split("\n")
    .map((l) => l.trim());
  const autoTranslate = document.getElementById("ocr-auto-translate").checked;

  if (enLines.length === 0) {
    showToast("登録する英文がありません。写真を読み取るか、直接入力してください。", 6000);
    return;
  }

  // すでに同じ英文があるカードは重複登録しない
  const existing = new Set(cards.map((c) => speakableEnglish(c.en).toLowerCase()));
  const newEntries = [];
  let skipped = 0;
  for (let i = 0; i < enLines.length; i++) {
    if (existing.has(speakableEnglish(enLines[i]).toLowerCase())) {
      skipped++;
      continue;
    }
    newEntries.push({ en: enLines[i], ja: (jaLines[i] || "").trim() });
  }

  if (newEntries.length === 0) {
    showToast(`すべて登録済みの英文でした(${skipped}件)。`, 6000);
    return;
  }

  ocrRegisterBtn.disabled = true;

  const untranslated = newEntries.filter((e) => !e.ja);
  if (autoTranslate && untranslated.length > 0) {
    showToast(`🌐 ${untranslated.length}件の日本語訳を取得しています…`, 60000);
    for (const entry of untranslated) {
      entry.ja = await translateEnToJa(entry.en);
      await new Promise((r) => setTimeout(r, 300)); // APIへの連続アクセスを控えめに
    }
  }

  for (const entry of newEntries.reverse()) {
    addCard(entry); // unshift なので逆順に入れて元の順を保つ
  }

  ocrRegisterBtn.disabled = false;
  render();
  photoDialog.close();
  document.getElementById("ocr-en-text").value = "";
  document.getElementById("ocr-ja-text").value = "";
  showToast(
    `✅ ${newEntries.length}枚のカードを登録しました。` +
      (skipped ? `(登録済み${skipped}件はスキップ)` : "")
  );
});

// ---------------------------------------------------------------------------
// カードの追加・編集フォーム
// ---------------------------------------------------------------------------

const cardDialog = document.getElementById("card-dialog");
const cardForm = document.getElementById("card-form");
const cardFormStatus = document.getElementById("card-form-status");

function openCardForm(card = {}) {
  document.getElementById("card-dialog-title").textContent = card.id
    ? "カードを編集"
    : "カードを追加";
  document.getElementById("card-id").value = card.id || "";
  document.getElementById("card-en").value = card.en || "";
  document.getElementById("card-ja").value = card.ja || "";
  cardFormStatus.textContent = "";
  cardDialog.showModal();
}

cardForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const id = document.getElementById("card-id").value;
  const fields = {
    en: document.getElementById("card-en").value.trim(),
    ja: document.getElementById("card-ja").value.trim(),
  };
  if (!fields.en) return;
  if (id) {
    updateCard(id, fields);
  } else {
    addCard(fields);
    render();
  }
  cardDialog.close();
});

document.getElementById("manual-add-btn").addEventListener("click", () => openCardForm());
document.getElementById("card-form-cancel").addEventListener("click", () => cardDialog.close());

document.getElementById("card-translate-btn").addEventListener("click", async (e) => {
  const en = document.getElementById("card-en").value.trim();
  if (!en) {
    cardFormStatus.textContent = "先に英文を入力してください。";
    return;
  }
  e.target.disabled = true;
  cardFormStatus.textContent = "🌐 翻訳しています…";
  const ja = await translateEnToJa(en);
  e.target.disabled = false;
  if (ja) {
    document.getElementById("card-ja").value = ja;
    cardFormStatus.textContent = "翻訳しました。不自然なところは直してください。";
  } else {
    cardFormStatus.textContent = "翻訳を取得できませんでした。手で入力してください。";
  }
});

// ---------------------------------------------------------------------------
// 一覧表示
// ---------------------------------------------------------------------------

const cardList = document.getElementById("card-list");
const emptyMessage = document.getElementById("empty-message");
const studySummary = document.getElementById("study-summary");

const EMPTY_MESSAGES = {
  due: "今日の復習はありません 🎉 「📷 写真から追加」で英文を増やしましょう。",
  all: "カードがまだありません。「📷 写真から追加」で英文を登録しましょう。",
};

function levelLabel(card) {
  if (card.reviews === 0) return "🌱 新規";
  return `Lv.${card.level}`;
}

function dueLabel(card) {
  const today = toLocalDateStr();
  if (card.dueAt <= today) return `<span class="due-badge">今日復習</span>`;
  return "";
}

function render() {
  const due = dueCards();
  studySummary.textContent = `今日の復習: ${due.length}枚 / 全${cards.length}枚`;

  let list;
  if (currentFilter === "due") {
    list = due.slice().sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1));
  } else {
    list = cards.slice();
  }

  emptyMessage.classList.toggle("hidden", list.length > 0);
  emptyMessage.textContent = EMPTY_MESSAGES[currentFilter];
  cardList.innerHTML = list.map(renderCard).join("");
}

function renderCard(card) {
  const nextInfo =
    card.dueAt > toLocalDateStr() ? `次回 ${card.dueAt.replaceAll("-", "/")}` : "";
  return `
    <li class="eigo-card">
      <p class="eigo-card-en">${chunkHtml(card.en)}${dueLabel(card)}</p>
      ${card.ja ? `<p class="eigo-card-ja">${chunkHtml(card.ja)}</p>` : ""}
      <p class="eigo-card-meta">
        <span class="level-badge">${levelLabel(card)}</span>
        ${card.audio?.trackId ? '<span class="level-badge">🎧 音声つき</span>' : ""}
        ${nextInfo}
      </p>
      <div class="book-actions">
        <button class="btn btn-small" data-action="speak" data-id="${card.id}">${card.audio?.trackId ? "🎧" : "🔊"} 聞く</button>
        <button class="btn btn-small" data-action="edit" data-id="${card.id}">✏️ 編集</button>
        <button class="btn btn-small btn-danger" data-action="delete" data-id="${card.id}">🗑 削除</button>
      </div>
    </li>`;
}

cardList.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  const card = cards.find((c) => c.id === id);
  if (!card) return;
  switch (action) {
    case "speak":
      playCard(card);
      break;
    case "edit":
      openCardForm(card);
      break;
    case "delete":
      if (confirm("このカードを削除しますか?\n" + card.en)) deleteCard(id);
      break;
  }
});

document.getElementById("filter-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  currentFilter = tab.dataset.filter;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  render();
});

// ---------------------------------------------------------------------------
// 音声読み上げ (Web Speech API: speechSynthesis)
// ---------------------------------------------------------------------------

let voices = [];
function refreshVoices() {
  voices = speechSynthesis.getVoices();
}
if ("speechSynthesis" in window) {
  refreshVoices();
  speechSynthesis.addEventListener("voiceschanged", refreshVoices);
}

function pickEnglishVoice() {
  return (
    voices.find((v) => v.lang === "en-US" && v.localService) ||
    voices.find((v) => v.lang === "en-US") ||
    voices.find((v) => v.lang.startsWith("en")) ||
    null
  );
}

function speak(text, rate = 1.0, onEnd = null) {
  if (!("speechSynthesis" in window)) {
    showToast("このブラウザは読み上げに対応していません。", 6000);
    if (onEnd) onEnd();
    return;
  }
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "en-US";
  const voice = pickEnglishVoice();
  if (voice) utter.voice = voice;
  utter.rate = rate;
  if (onEnd) {
    utter.onend = onEnd;
    utter.onerror = onEnd;
  }
  speechSynthesis.speak(utter);
}

// ---------------------------------------------------------------------------
// 音声ファイル (教材音声を IndexedDB に保存し、カードに区切りを割り当てて再生)
// ---------------------------------------------------------------------------

const AUDIO_DB = "english.audio.v1";

let audioDbPromise = null;
function openAudioDb() {
  if (audioDbPromise) return audioDbPromise;
  audioDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(AUDIO_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("tracks", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return audioDbPromise;
}

async function dbPutTrack(track) {
  const db = await openAudioDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tracks", "readwrite");
    tx.objectStore("tracks").put(track);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetTrack(id) {
  const db = await openAudioDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("tracks").objectStore("tracks").get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbAllTracks() {
  const db = await openAudioDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("tracks").objectStore("tracks").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbDeleteTrack(id) {
  const db = await openAudioDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tracks", "readwrite");
    tx.objectStore("tracks").delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// --- クリップ再生 ---

const clipAudio = new Audio();
const trackUrlCache = new Map(); // trackId → objectURL
let clipStopLoop = null;

async function trackObjectUrl(trackId) {
  if (trackUrlCache.has(trackId)) return trackUrlCache.get(trackId);
  const track = await dbGetTrack(trackId);
  if (!track) return null;
  const url = URL.createObjectURL(track.blob);
  trackUrlCache.set(trackId, url);
  return url;
}

function stopClip() {
  if (clipStopLoop) {
    cancelAnimationFrame(clipStopLoop);
    clipStopLoop = null;
  }
  if (!clipAudio.paused) clipAudio.pause();
}

/** トラックの start〜end 秒を再生する。トラックが無ければ false */
async function playClip({ trackId, start = 0, end = 0 }, rate = 1) {
  const url = await trackObjectUrl(trackId);
  if (!url) return false;
  stopClip();
  window.speechSynthesis?.cancel();
  if (clipAudio.src !== url) {
    clipAudio.src = url;
    await new Promise((resolve) => {
      if (clipAudio.readyState > 0) return resolve();
      clipAudio.addEventListener("loadedmetadata", resolve, { once: true });
      clipAudio.addEventListener("error", resolve, { once: true });
    });
  }
  clipAudio.playbackRate = rate;
  clipAudio.currentTime = start;
  try {
    await clipAudio.play();
  } catch {
    return false;
  }
  if (end > start) {
    const check = () => {
      if (clipAudio.paused) {
        clipStopLoop = null;
        return;
      }
      if (clipAudio.currentTime >= end) {
        clipAudio.pause();
        clipStopLoop = null;
        return;
      }
      clipStopLoop = requestAnimationFrame(check);
    };
    clipStopLoop = requestAnimationFrame(check);
  }
  return true;
}

/**
 * カードのお手本を再生する。音声クリップが割り当てられていれば本物の音声、
 * 無ければ読み上げ(TTS)にフォールバック
 */
async function playCard(card, slow = false) {
  if (card.audio?.trackId) {
    const ok = await playClip(card.audio, slow ? 0.7 : 1);
    if (ok) return;
  }
  speak(speakableEnglish(card.en), slow ? 0.6 : 1);
}

// --- 音声ダイアログ(取り込み・一覧) ---

const audioDialog = document.getElementById("audio-dialog");
const trackListEl = document.getElementById("track-list");

function formatBytes(n) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}

async function renderTrackList() {
  let tracks = [];
  try {
    tracks = await dbAllTracks();
  } catch {
    trackListEl.innerHTML = `<li class="hint">この端末では音声の保存を利用できません。</li>`;
    return;
  }
  if (tracks.length === 0) {
    trackListEl.innerHTML = `<li class="hint">音声はまだありません。「➕ 音声を取り込む」から追加してください。</li>`;
    return;
  }
  tracks.sort((a, b) => (a.addedAt < b.addedAt ? -1 : 1));
  trackListEl.innerHTML = tracks
    .map((t) => {
      const assigned = cards.filter((c) => c.audio?.trackId === t.id).length;
      return `<li class="track-item">
        <div class="track-info">
          <span class="track-name">🎵 ${escapeHtml(t.name)}</span>
          <span class="track-meta">${formatBytes(t.size)} ・ 割り当て済み ${assigned}枚</span>
        </div>
        <div class="track-actions">
          <button class="btn btn-small" data-track-action="segment" data-id="${t.id}">✂️ 区切りを付ける</button>
          <button class="btn btn-small btn-danger" data-track-action="delete" data-id="${t.id}">🗑</button>
        </div>
      </li>`;
    })
    .join("");
}

document.getElementById("audio-btn").addEventListener("click", () => {
  renderTrackList();
  audioDialog.showModal();
});
document.getElementById("audio-close").addEventListener("click", () => audioDialog.close());

document.getElementById("audio-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const track = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: file.name,
    size: file.size,
    blob: file,
    addedAt: new Date().toISOString(),
  };
  try {
    await dbPutTrack(track);
  } catch {
    showToast("音声を保存できませんでした。空き容量やブラウザ設定を確認してください。", 7000);
    return;
  }
  showToast(`🎵 「${file.name}」を取り込みました。次は「✂️ 区切りを付ける」でカードに割り当てましょう。`, 7000);
  renderTrackList();
});

trackListEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-track-action]");
  if (!btn) return;
  const { trackAction, id } = btn.dataset;
  if (trackAction === "segment") {
    audioDialog.close();
    openSegmentDialog(id);
  } else if (trackAction === "delete") {
    const track = await dbGetTrack(id);
    if (!confirm(`「${track?.name || "この音声"}」を削除しますか?\nカードへの割り当ても解除されます。`)) return;
    await dbDeleteTrack(id);
    const url = trackUrlCache.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      trackUrlCache.delete(id);
    }
    let changed = false;
    for (const c of cards) {
      if (c.audio?.trackId === id) {
        c.audio = null;
        changed = true;
      }
    }
    if (changed) saveCards();
    render();
    renderTrackList();
  }
});

// --- 区切り付け(タップでカードに割り当て) ---

const segmentDialog = document.getElementById("segment-dialog");
const segAudio = document.getElementById("segment-audio");
const segCardList = document.getElementById("segment-card-list");

let seg = null; // { trackId, cards, index, start }

async function openSegmentDialog(trackId) {
  if (cards.length === 0) {
    showToast("カードがまだありません。先に英文を登録してください。", 6000);
    return;
  }
  const track = await dbGetTrack(trackId);
  if (!track) return;
  const url = await trackObjectUrl(trackId);
  stopClip();
  segAudio.src = url;
  document.getElementById("segment-track-name").textContent = `🎵 ${track.name}`;
  seg = {
    trackId,
    cards: cards.slice(), // トレーニングと同じ並び(会話の順)
    index: 0,
    start: 0,
  };
  renderSegmentList();
  segmentDialog.showModal();
}

function segTimeLabel(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

function renderSegmentList() {
  if (!seg) return;
  segCardList.innerHTML = seg.cards
    .map((c, i) => {
      const a = c.audio?.trackId === seg.trackId ? c.audio : null;
      const range = a ? `${segTimeLabel(a.start)} 〜 ${segTimeLabel(a.end)}` : "―";
      return `<li class="segment-row${i === seg.index ? " current" : ""}" data-index="${i}">
        <span class="segment-row-no">${i + 1}</span>
        <span class="segment-row-en">${escapeHtml(c.en)}</span>
        <span class="segment-row-time">${range}</span>
      </li>`;
    })
    .join("");
  const current = segCardList.querySelector(".segment-row.current");
  if (current) current.scrollIntoView({ block: "nearest" });
}

document.getElementById("seg-mark").addEventListener("click", () => {
  if (!seg) return;
  if (seg.index >= seg.cards.length) {
    showToast("すべてのカードに割り当て済みです。", 5000);
    return;
  }
  const t = segAudio.currentTime;
  if (t <= seg.start + 0.2) return; // 同じ場所での連打は無視
  const card = seg.cards[seg.index];
  updateCard(card.id, { audio: { trackId: seg.trackId, start: seg.start, end: t } });
  seg.start = t;
  seg.index++;
  renderSegmentList();
  if (seg.index >= seg.cards.length) {
    segAudio.pause();
    showToast("🎉 すべてのカードに音声を割り当てました!");
  }
});

document.getElementById("seg-back").addEventListener("click", () => {
  segAudio.currentTime = Math.max(0, segAudio.currentTime - 3);
});

document.getElementById("seg-undo").addEventListener("click", () => {
  if (!seg || seg.index === 0) return;
  seg.index--;
  const card = seg.cards[seg.index];
  const prevStart = card.audio?.start ?? 0;
  updateCard(card.id, { audio: null });
  seg.start = prevStart;
  segAudio.currentTime = prevStart;
  renderSegmentList();
});

segCardList.addEventListener("click", (e) => {
  const row = e.target.closest(".segment-row");
  if (!row || !seg) return;
  const i = Number(row.dataset.index);
  seg.index = i;
  // そのカードの割り当て済み開始位置、無ければ現在の再生位置から区切り直す
  const existing = seg.cards[i].audio;
  seg.start = existing?.trackId === seg.trackId ? existing.start : segAudio.currentTime;
  segAudio.currentTime = seg.start;
  renderSegmentList();
});

document.getElementById("segment-close").addEventListener("click", () => segmentDialog.close());
segmentDialog.addEventListener("close", () => {
  segAudio.pause();
  seg = null;
  render();
});

// ---------------------------------------------------------------------------
// 発音チェック (Web Speech API: SpeechRecognition)
// ---------------------------------------------------------------------------

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

const recordBtn = document.getElementById("record-btn");
const pronResult = document.getElementById("pron-result");

// 発音チェックはボタン/結果表示を差し替えられるようにして、復習・トレーニング両方から使う
let activeRecordBtn = recordBtn;
let activeRecordLabel = "🎤 発音チェック";

function stopRecognition() {
  if (recognition) {
    try {
      recognition.abort();
    } catch {}
    recognition = null;
  }
  if (activeRecordBtn) {
    activeRecordBtn.classList.remove("record-btn-active");
    activeRecordBtn.textContent = activeRecordLabel;
  }
}

/** 目標の単語列に対して、話した単語列が最長でどれだけ一致するか(LCS)を単語ごとに求める */
function matchWords(target, spoken) {
  const n = target.length;
  const m = spoken.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        target[i] === spoken[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const flags = new Array(n).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (target[i] === spoken[j]) {
      flags[i] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return flags;
}

function showPronResult(targetText, spokenText, resultEl = pronResult) {
  const targetWords = tokenizeEnglish(targetText);
  const spokenWords = tokenizeEnglish(spokenText);
  const flags = matchWords(targetWords, spokenWords);
  const hit = flags.filter(Boolean).length;
  const score = targetWords.length ? Math.round((hit / targetWords.length) * 100) : 0;

  const message =
    score >= 90 ? "すばらしい発音です!" :
    score >= 70 ? "いい感じ!赤い単語をもう一度。" :
    score >= 40 ? "おしい!ゆっくり区切って言ってみましょう。" :
    "もう一度チャレンジ。🔊で聞いてから真似してみてください。";

  const wordsHtml = targetWords
    .map(
      (w, idx) =>
        `<span class="pron-word ${flags[idx] ? "hit" : "miss"}">${escapeHtml(w)}</span>`
    )
    .join("");

  resultEl.innerHTML = `
    <p class="pron-score">🎯 ${score}点 — ${escapeHtml(message)}</p>
    <p class="pron-words">${wordsHtml}</p>
    <p class="pron-heard">聞き取られた音声: ${spokenText ? escapeHtml(spokenText) : "(認識できませんでした)"}</p>`;
  resultEl.classList.remove("hidden");
}

function startPronunciationCheck(targetText, opts = {}) {
  const button = opts.button || recordBtn;
  const resultEl = opts.result || pronResult;
  const label = opts.label || "🎤 発音チェック";
  if (!SpeechRecognitionCtor) {
    showToast("このブラウザは音声認識に対応していません(ChromeやSafariでお試しください)。", 7000);
    return;
  }
  if (recognition) {
    stopRecognition();
    return;
  }
  // マイクがお手本の音を拾うと採点にならないので、再生は必ず止めてから聞き取る
  stopPlayAll();

  activeRecordBtn = button;
  activeRecordLabel = label;

  recognition = new SpeechRecognitionCtor();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 5;

  button.classList.add("record-btn-active");
  button.textContent = "⏹ 話し終えたらタップ";
  resultEl.classList.add("hidden");

  recognition.onresult = (event) => {
    // 候補の中からいちばんスコアが高くなる聞き取り結果を採用する
    const alternatives = Array.from(event.results[0]);
    const targetWords = tokenizeEnglish(targetText);
    let best = alternatives[0]?.transcript || "";
    let bestScore = -1;
    for (const alt of alternatives) {
      const flags = matchWords(targetWords, tokenizeEnglish(alt.transcript));
      const score = flags.filter(Boolean).length;
      if (score > bestScore) {
        bestScore = score;
        best = alt.transcript;
      }
    }
    showPronResult(targetText, best, resultEl);
  };
  recognition.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      showToast("マイクの使用が許可されていません。ブラウザの設定を確認してください。", 7000);
    } else if (event.error !== "aborted") {
      showPronResult(targetText, "", resultEl);
    }
  };
  recognition.onend = () => {
    recognition = null;
    button.classList.remove("record-btn-active");
    button.textContent = label;
  };

  try {
    recognition.start();
  } catch {
    stopRecognition();
  }
}

// ---------------------------------------------------------------------------
// 復習セッション (間隔反復)
// ---------------------------------------------------------------------------

const practiceDialog = document.getElementById("practice-dialog");
const practicePrompt = document.getElementById("practice-prompt");
const practiceHint = document.getElementById("practice-hint");
const practiceAnswer = document.getElementById("practice-answer");
const practiceAnswerMain = document.getElementById("practice-answer-main");
const practiceProgress = document.getElementById("practice-progress");
const practiceTools = document.getElementById("practice-tools");
const revealBtn = document.getElementById("reveal-btn");
const gradeButtons = document.getElementById("grade-buttons");

let queue = [];
let sessionTotal = 0;
let doneCount = 0;
let currentCard = null;
let practiceMode = "ja-en"; // "ja-en" = 日本語を見て英語を思い出す

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function startPractice() {
  let targets = dueCards();
  if (targets.length === 0) {
    if (cards.length === 0) {
      showToast("カードがまだありません。まず英文を登録しましょう。", 6000);
      return;
    }
    if (!confirm("今日の復習はありません 🎉\nすべてのカードから練習しますか?")) return;
    targets = cards.slice();
  }
  queue = shuffle(targets.slice());
  sessionTotal = queue.length;
  doneCount = 0;
  practiceDialog.showModal();
  showNextCard();
}

function showNextCard() {
  stopRecognition();
  window.speechSynthesis?.cancel();
  stopClip();
  if (queue.length === 0) {
    practiceDialog.close();
    showToast(`🎉 復習おわり!${sessionTotal}枚がんばりました。`);
    render();
    return;
  }
  currentCard = queue[0];
  practiceProgress.textContent = `${doneCount + 1} / ${sessionTotal}`;
  pronResult.classList.add("hidden");
  practiceAnswer.classList.add("hidden");
  gradeButtons.classList.add("hidden");
  revealBtn.classList.remove("hidden");

  if (practiceMode === "ja-en") {
    practiceHint.textContent = "🇯🇵 → 🇬🇧 日本語を見て、英語で言ってみましょう";
    practicePrompt.innerHTML = currentCard.ja
      ? chunkHtml(currentCard.ja)
      : "(日本語訳が未登録のカードです。答えを見て覚えましょう)";
    practiceTools.classList.add("hidden"); // 答えが英語なので、答えを見るまで隠す
  } else {
    practiceHint.textContent = "🇬🇧 → 🇯🇵 英語を読んで、意味を思い出しましょう";
    practicePrompt.innerHTML = chunkHtml(currentCard.en);
    practiceTools.classList.remove("hidden"); // 英語が見えているので発音練習もできる
  }
}

function reveal() {
  if (!currentCard) return;
  practiceAnswer.classList.remove("hidden");
  practiceAnswerMain.innerHTML =
    practiceMode === "ja-en"
      ? chunkHtml(currentCard.en)
      : currentCard.ja
        ? chunkHtml(currentCard.ja)
        : "(日本語訳が未登録です。✏️ 編集から追加できます)";
  practiceTools.classList.remove("hidden");
  revealBtn.classList.add("hidden");
  gradeButtons.classList.remove("hidden");
}

function grade(result) {
  if (!currentCard) return;
  const card = currentCard;
  queue.shift();

  card.reviews = (card.reviews || 0) + 1;
  if (result === "again") {
    card.level = 0;
    card.lapses = (card.lapses || 0) + 1;
    card.dueAt = toLocalDateStr();
    queue.push(card); // このセッション中にもう一度出す
  } else {
    const step = result === "easy" ? 2 : 1;
    card.level = Math.min(MAX_LEVEL, (card.level || 0) + step);
    card.dueAt = addDays(toLocalDateStr(), INTERVALS[card.level]);
    doneCount++;
  }
  card.lastReviewedAt = new Date().toISOString();
  saveCards();
  showNextCard();
}

document.getElementById("practice-start-btn").addEventListener("click", startPractice);
revealBtn.addEventListener("click", reveal);

gradeButtons.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-grade]");
  if (btn) grade(btn.dataset.grade);
});

document.getElementById("mode-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".mode-btn");
  if (!btn) return;
  practiceMode = btn.dataset.mode;
  document
    .querySelectorAll(".mode-btn")
    .forEach((b) => b.classList.toggle("active", b === btn));
  if (currentCard) showNextCard(); // 表示中のカードを新しいモードで出し直す
});

document.getElementById("speak-btn").addEventListener("click", () => {
  if (currentCard) playCard(currentCard);
});
document.getElementById("speak-slow-btn").addEventListener("click", () => {
  if (currentCard) playCard(currentCard, true);
});
recordBtn.addEventListener("click", () => {
  if (currentCard) startPronunciationCheck(speakableEnglish(currentCard.en));
});

document.getElementById("practice-close").addEventListener("click", () => {
  practiceDialog.close();
});
practiceDialog.addEventListener("close", () => {
  stopRecognition();
  window.speechSynthesis?.cancel();
  stopClip();
  currentCard = null;
  render();
});

// ---------------------------------------------------------------------------
// トレーニング (4段階メソッド: Input → Output → Input → Output)
//   1) Input : シャドーイング / オーバーラッピング / 音読 / 精読
//   2) Output: リテンション / リピーティング
//   3) Input : 頭ごなし訳(英→日)
//   4) Output: 高速和文英訳 / 頭ごなし訳(日→英)
// ---------------------------------------------------------------------------

/** 和訳を小さく添える(オーバーラッピング・音読で意味を確認しながら発音するため) */
function jaSub(card) {
  return card.ja ? `<p class="training-sub">${chunkHtml(card.ja)}</p>` : "";
}

/** チャンク対応表(精読で使用)。対応が取れなければ英文・和訳をそのまま並べる */
function chunkTableHtml(card) {
  const pairs = chunkPairs(card.en, card.ja);
  if (!pairs) {
    return (
      `<p class="training-main">${chunkHtml(card.en)}</p>` +
      (card.ja ? `<p class="training-sub">${chunkHtml(card.ja)}</p>` : "")
    );
  }
  const rows = pairs
    .map(
      (p) =>
        `<div class="chunk-row">
           <span class="chunk-src">${escapeHtml(p.en)}</span>
           <span class="chunk-tgt revealed">${escapeHtml(p.ja)}</span>
         </div>`
    )
    .join("");
  return `<div class="chunk-table">${rows}</div>`;
}

const TRAINING_METHODS = {
  shadowing: {
    stage: 1, stageLabel: "① Input", name: "シャドーイング", icon: "🗣️",
    hint: "テキストを見ずに、音声に少し遅れて“影のように”真似して発音しましょう。",
    autoplay: true, prompt: () => "", reveal: "en",
    tools: ["play", "slow", "record", "reveal"],
  },
  overlapping: {
    stage: 1, stageLabel: "① Input", name: "オーバーラッピング", icon: "🎯",
    hint: "テキストを見ながら、音声にぴったり重ねて“同時に”発音しましょう。",
    autoplay: true, prompt: (c) => chunkHtml(c.en) + jaSub(c),
    tools: ["play", "slow"],
  },
  reading: {
    stage: 1, stageLabel: "① Input", name: "音読", icon: "📢",
    hint: "英文を声に出して読みましょう。🎤で発音を確かめられます。",
    autoplay: false, prompt: (c) => chunkHtml(c.en) + jaSub(c),
    tools: ["play", "slow", "record"],
  },
  intensive: {
    stage: 1, stageLabel: "① Input", name: "精読", icon: "🔍",
    hint: "チャンク(区切り)ごとに、文法・語彙・意味をていねいに理解しましょう。",
    autoplay: false, prompt: (c) => chunkTableHtml(c),
    tools: ["play"],
  },
  retention: {
    stage: 2, stageLabel: "② Output", name: "リテンション", icon: "🧠",
    hint: "音声を聞いて頭の中に保持し、テキストを見ずに口に出して再現しましょう。",
    autoplay: true, prompt: () => "", reveal: "en",
    tools: ["play", "record", "reveal"],
  },
  repeating: {
    stage: 2, stageLabel: "② Output", name: "リピーティング", icon: "🔁",
    hint: "音声を最後まで聞いてから、テキストを見ずに繰り返して発音しましょう。",
    autoplay: true, prompt: () => "", reveal: "en",
    tools: ["play", "record", "reveal"],
  },
  sightEJ: {
    stage: 3, stageLabel: "③ Input", name: "頭ごなし訳(英→日)", icon: "⚡",
    hint: "英語を語順のまま、前から順にチャンクごとに日本語にしていきましょう。",
    chunk: "en-ja", tools: ["play", "slow"],
  },
  qtrans: {
    stage: 4, stageLabel: "④ Output", name: "高速和文英訳", icon: "💨",
    hint: "日本語を見て、できるだけ速く英語に直して声に出しましょう。",
    autoplay: false, timer: true,
    prompt: (c) => (c.ja ? chunkHtml(c.ja) : "(日本語訳が未登録です。✏️ 編集から追加できます)"),
    reveal: "en", tools: ["record", "reveal", "play"],
  },
  sightJE: {
    stage: 4, stageLabel: "④ Output", name: "頭ごなし訳(日→英)", icon: "⚡",
    hint: "日本語を語順のまま、前から順にチャンクごとに英語にしていきましょう。",
    chunk: "ja-en", tools: ["play", "record"],
  },
};

const STAGE_ORDER = [
  {
    label: "① Input",
    desc: "英文を体にしみ込ませる",
    methods: ["shadowing", "overlapping", "reading", "intensive"],
  },
  {
    label: "② Output",
    desc: "①をもとに発信力を鍛える(文法・語彙・表現の反復)",
    methods: ["retention", "repeating"],
  },
  {
    label: "③ Input",
    desc: "①〜②をもとに、発信のための基盤づくり",
    methods: ["sightEJ"],
  },
  {
    label: "④ Output",
    desc: "①〜③をもとに、伝えたいことを瞬時に英語で発信",
    methods: ["qtrans", "sightJE"],
  },
];

const trainingMenuDialog = document.getElementById("training-menu-dialog");
const trainingDialog = document.getElementById("training-dialog");
const trBody = document.getElementById("training-body");
const trPronResult = document.getElementById("training-pron-result");
const trRecordBtn = document.getElementById("tr-record");

let training = null; // { methodId, cards, index, chunkStep, timerId }

function openTrainingMenu() {
  const menu = document.getElementById("training-menu");
  menu.innerHTML = STAGE_ORDER.map(
    (stage) => `
    <section class="stage-block">
      <h3 class="stage-title">${stage.label}<span class="stage-desc">${stage.desc}</span></h3>
      <div class="method-grid">
        ${stage.methods
          .map((id) => {
            const m = TRAINING_METHODS[id];
            return `<button class="method-btn" data-method="${id}">
                      <span class="method-icon">${m.icon}</span>
                      <span class="method-name">${m.name}</span>
                    </button>`;
          })
          .join("")}
      </div>
    </section>`
  ).join("");
  trainingMenuDialog.showModal();
}

function startTraining(methodId) {
  if (cards.length === 0) {
    showToast("カードがまだありません。まず英文を登録しましょう。", 6000);
    return;
  }
  trainingMenuDialog.close();
  training = {
    methodId,
    cards: cards.slice(), // 会話の流れを保つため登録順のまま
    index: 0,
    chunkStep: 0,
    timerId: null,
  };
  trainingDialog.showModal();
  renderTrainingStep();
}

function stopTrainingTimer() {
  if (training?.timerId) {
    clearInterval(training.timerId);
    training.timerId = null;
  }
}

function renderTrainingStep() {
  stopRecognition();
  window.speechSynthesis?.cancel();
  stopClip();
  stopTrainingTimer();
  if (!training) return;

  const method = TRAINING_METHODS[training.methodId];
  const card = training.cards[training.index];

  document.getElementById("training-stage-label").textContent = method.stageLabel;
  document.getElementById("training-method-name").textContent = `${method.icon} ${method.name}`;
  document.getElementById("training-hint").textContent = method.hint;
  document.getElementById("training-progress").textContent =
    `${training.index + 1} / ${training.cards.length}`;
  trPronResult.classList.add("hidden");
  trPronResult.innerHTML = "";

  document.getElementById("tr-reveal").classList.add("hidden");
  document.getElementById("training-answer").classList.add("hidden");
  document.getElementById("training-answer").innerHTML = "";

  training.chunkStep = 0;

  if (method.chunk) {
    renderChunkStep();
  } else {
    trBody.innerHTML = method.prompt ? `<div class="training-prompt">${method.prompt(card)}</div>` : "";
    if (!method.prompt || method.prompt(card) === "") {
      trBody.innerHTML = `<p class="training-blank">🔊 音声を聞いて発音しましょう(テキストは「👁 答え」で確認)</p>`;
    }
    if (method.timer) startTrainingTimer();
    if (method.reveal) document.getElementById("tr-reveal").classList.remove("hidden");
  }

  setupTrainingTools(method);

  // シャドーイング等は自動で1回お手本を再生する
  if (method.autoplay) {
    playCard(card);
  }
}

function startTrainingTimer() {
  const el = document.getElementById("training-timer");
  el.classList.remove("hidden");
  const start = Date.now();
  const tick = () => {
    el.textContent = `⏱ ${((Date.now() - start) / 1000).toFixed(1)} 秒`;
  };
  tick();
  training.timerId = setInterval(tick, 100);
}

/** チャンクごとの頭ごなし訳を段階表示する */
function renderChunkStep() {
  const method = TRAINING_METHODS[training.methodId];
  const card = training.cards[training.index];
  const pairs = chunkPairs(card.en, card.ja);
  const srcIsEn = method.chunk === "en-ja";

  const chunkBtn = document.getElementById("tr-chunk");

  if (!pairs) {
    // チャンク対応が取れないカードは、全文を出して裏返す形にフォールバック
    const srcText = srcIsEn ? card.en : card.ja;
    const tgtText = srcIsEn ? card.ja : card.en;
    trBody.innerHTML = `<div class="training-prompt">${chunkHtml(srcText || "(未登録)")}</div>`;
    const answer = document.getElementById("training-answer");
    if (training.chunkStep > 0) {
      answer.innerHTML = chunkHtml(tgtText || "(未登録)");
      answer.classList.remove("hidden");
      chunkBtn.classList.add("hidden");
    } else {
      answer.classList.add("hidden");
      chunkBtn.textContent = "答えを見る";
      chunkBtn.classList.remove("hidden");
    }
    return;
  }

  const rows = pairs
    .map((p, i) => {
      const src = srcIsEn ? p.en : p.ja;
      const tgt = srcIsEn ? p.ja : p.en;
      const revealed = i < training.chunkStep;
      const isCurrent = i === training.chunkStep;
      return `<div class="chunk-row${isCurrent ? " current" : ""}">
                <span class="chunk-src">${escapeHtml(src)}</span>
                <span class="chunk-tgt${revealed ? " revealed" : ""}">${
                  revealed ? escapeHtml(tgt) : "―"
                }</span>
              </div>`;
    })
    .join("");
  trBody.innerHTML = `<div class="chunk-table stepping">${rows}</div>`;

  if (training.chunkStep >= pairs.length) {
    chunkBtn.classList.add("hidden");
  } else {
    chunkBtn.textContent = training.chunkStep === 0 ? "▶ 訳を出す" : "▶ 次のチャンク";
    chunkBtn.classList.remove("hidden");
  }
}

function advanceChunk() {
  const method = TRAINING_METHODS[training.methodId];
  const card = training.cards[training.index];
  const pairs = chunkPairs(card.en, card.ja);
  training.chunkStep++;
  if (!pairs) {
    renderChunkStep();
    return;
  }
  renderChunkStep();
}

function setupTrainingTools(method) {
  const map = {
    play: "tr-play",
    slow: "tr-slow",
    record: "tr-record",
  };
  for (const [tool, id] of Object.entries(map)) {
    document.getElementById(id).classList.toggle("hidden", !method.tools.includes(tool));
  }
  // チャンクモードのときだけ「次のチャンク」ボタンを出す
  document.getElementById("tr-chunk").classList.toggle("hidden", !method.chunk);
  document.getElementById("training-timer").classList.toggle("hidden", !method.timer);
  trRecordBtn.textContent = "🎤 発音チェック";
}

function trainingReveal() {
  const method = TRAINING_METHODS[training.methodId];
  const card = training.cards[training.index];
  stopTrainingTimer();
  const answer = document.getElementById("training-answer");
  answer.innerHTML =
    method.reveal === "en" ? chunkHtml(card.en) : chunkHtml(card.ja || "(未登録)");
  answer.classList.remove("hidden");
  document.getElementById("tr-reveal").classList.add("hidden");
  // 答えが出たら発音チェックも使えるように play を確実に出す
  document.getElementById("tr-play").classList.remove("hidden");
}

function trainingNext(step = 1) {
  if (!training) return;
  const next = training.index + step;
  if (next < 0) return;
  if (next >= training.cards.length) {
    trainingDialog.close();
    showToast(`🎉 ${TRAINING_METHODS[training.methodId].name} おわり!${training.cards.length}枚やりました。`);
    return;
  }
  training.index = next;
  renderTrainingStep();
}

// --- イベント ---

document.getElementById("training-menu-btn").addEventListener("click", openTrainingMenu);
document.getElementById("training-menu-close").addEventListener("click", () => trainingMenuDialog.close());

let trainingScope = "card"; // "card" = 1枚ずつ / "full" = 全文とおし

const SCOPE_HINTS = {
  card: "1枚ずつじっくり。ページ送りしながら練習します。",
  full: "会話全体をとおしで練習します。音声も全文を連続再生します。",
};

document.getElementById("scope-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".mode-btn");
  if (!btn) return;
  trainingScope = btn.dataset.scope;
  document
    .querySelectorAll("#scope-toggle .mode-btn")
    .forEach((b) => b.classList.toggle("active", b === btn));
  document.getElementById("scope-hint").textContent = SCOPE_HINTS[trainingScope];
});

document.getElementById("training-menu").addEventListener("click", (e) => {
  const btn = e.target.closest(".method-btn");
  if (!btn) return;
  if (trainingScope === "full") {
    startFulltext(btn.dataset.method);
  } else {
    startTraining(btn.dataset.method);
  }
});

document.getElementById("tr-play").addEventListener("click", () => {
  const card = training?.cards[training.index];
  if (card) playCard(card);
});
document.getElementById("tr-slow").addEventListener("click", () => {
  const card = training?.cards[training.index];
  if (card) playCard(card, true);
});
trRecordBtn.addEventListener("click", () => {
  const card = training?.cards[training.index];
  if (card) {
    startPronunciationCheck(speakableEnglish(card.en), {
      button: trRecordBtn,
      result: trPronResult,
    });
  }
});
document.getElementById("tr-reveal").addEventListener("click", trainingReveal);
document.getElementById("tr-chunk").addEventListener("click", advanceChunk);
document.getElementById("tr-next").addEventListener("click", () => trainingNext(1));
document.getElementById("tr-prev").addEventListener("click", () => trainingNext(-1));
document.getElementById("training-close").addEventListener("click", () => trainingDialog.close());

trainingDialog.addEventListener("close", () => {
  stopRecognition();
  window.speechSynthesis?.cancel();
  stopClip();
  stopTrainingTimer();
  training = null;
});

// ---------------------------------------------------------------------------
// 全文練習 (会話全体をとおしで練習する)
// ---------------------------------------------------------------------------

const fulltextDialog = document.getElementById("fulltext-dialog");
const ftEn = document.getElementById("ft-en");
const ftJa = document.getElementById("ft-ja");
const ftRevealBtn = document.getElementById("ft-reveal");

// 手法ごとの全文表示: hide-en = 英文を隠す / hide-ja = 日本語を隠す / show-all
const FULLTEXT_MODES = {
  shadowing: "hide-en",
  overlapping: "show-all",
  reading: "show-all",
  intensive: "show-all",
  retention: "hide-en",
  repeating: "hide-en",
  sightEJ: "hide-ja",
  qtrans: "hide-en",
  sightJE: "hide-en",
};

let fulltextCards = [];
let playAllToken = 0;

function stopPlayAll() {
  playAllToken++;
  stopClip();
  window.speechSynthesis?.cancel();
}

function speakAndWait(text, rate = 1) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "en-US";
    const voice = pickEnglishVoice();
    if (voice) utter.voice = voice;
    utter.rate = rate;
    utter.onend = resolve;
    utter.onerror = resolve;
    speechSynthesis.speak(utter);
  });
}

// 隣り合うカードのクリップがこの秒数以内でつながっていれば、
// 切り貼りせず元の音声をその区間ごと通しで再生する
const CLIP_MERGE_GAP = 3;

/**
 * 全文再生の計画を立てる。同じトラックで時間が連続しているクリップは
 * 1つの区間にまとめ、元の音声をそのまま通しで再生する(会話の間合いも残る)。
 * 音声が無いカードや、取り込まれていないトラックのカードはTTSで読む
 */
async function buildPlayPlan(list) {
  const available = new Map();
  for (const id of new Set(list.map((c) => c.audio?.trackId).filter(Boolean))) {
    available.set(id, Boolean(await dbGetTrack(id).catch(() => null)));
  }
  const plan = [];
  for (const card of list) {
    const a = card.audio;
    if (a?.trackId && available.get(a.trackId)) {
      const last = plan[plan.length - 1];
      if (
        last &&
        last.type === "clip" &&
        last.trackId === a.trackId &&
        a.start >= last.end - 0.5 &&
        a.start - last.end <= CLIP_MERGE_GAP
      ) {
        last.end = Math.max(last.end, a.end); // 連続 → 区間を伸ばすだけ
      } else {
        plan.push({ type: "clip", trackId: a.trackId, start: a.start, end: a.end });
      }
    } else {
      plan.push({ type: "tts", text: speakableEnglish(card.en) });
    }
  }
  return plan;
}

/** 全カードを会話の順に連続再生する(教材音声があればそれを使用) */
async function playAllCards(slow = false) {
  stopPlayAll();
  const token = playAllToken;
  const plan = await buildPlayPlan(fulltextCards);
  if (token !== playAllToken) return;
  for (const step of plan) {
    if (token !== playAllToken) return;
    if (step.type === "clip") {
      const ok = await playClip(step, slow ? 0.7 : 1);
      if (ok) {
        // 区間の終わりで自動停止するので、止まるまで待つ
        while (!clipAudio.paused && token === playAllToken) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    } else {
      await speakAndWait(step.text, slow ? 0.6 : 1);
    }
    if (token !== playAllToken) return;
    await new Promise((r) => setTimeout(r, 300)); // 区間の切り替わりの小休止
  }
}

function startFulltext(methodId) {
  if (cards.length === 0) {
    showToast("カードがまだありません。まず英文を登録しましょう。", 6000);
    return;
  }
  const m = TRAINING_METHODS[methodId];
  trainingMenuDialog.close();
  fulltextCards = cards.slice(); // 会話の流れを保つため登録順のまま

  document.getElementById("ft-stage").textContent = m.stageLabel;
  document.getElementById("ft-name").textContent = `${m.icon} ${m.name}(全文)`;
  document.getElementById("ft-hint").textContent = m.hint;

  ftEn.innerHTML = fulltextCards
    .map((c) => `<p class="ft-line">${chunkHtml(c.en)}</p>`)
    .join("");
  const jaLines = fulltextCards.filter((c) => c.ja);
  ftJa.innerHTML = jaLines.length
    ? fulltextCards
        .map((c) => `<p class="ft-line ft-line-ja">${c.ja ? chunkHtml(c.ja) : "―"}</p>`)
        .join("")
    : `<p class="hint">(日本語訳が未登録です)</p>`;

  const mode = FULLTEXT_MODES[methodId] || "show-all";
  ftEn.classList.toggle("hidden", mode === "hide-en");
  ftJa.classList.toggle("hidden", mode === "hide-ja");
  ftRevealBtn.classList.toggle("hidden", mode === "show-all");

  ftPronResult.classList.add("hidden");
  fulltextDialog.showModal();
  if (m.autoplay) playAllCards();
}

// --- 全文発音チェック (連続認識で長い発話を聞き取り、全文に対して採点) ---

const ftRecordBtn = document.getElementById("ft-record");
const ftPronResult = document.getElementById("ft-pron-result");
const FT_RECORD_LABEL = "🎤 全文発音チェック";

let ftRecognition = null;
let ftRecActive = false; // ユーザーが読み上げ中(勝手に切れたら再開する)
let ftRecCancelled = false;
let ftTranscript = "";

function fulltextTarget() {
  return fulltextCards.map((c) => speakableEnglish(c.en)).join(" ");
}

function resetFtRecordUi() {
  ftRecordBtn.classList.remove("record-btn-active");
  ftRecordBtn.textContent = FT_RECORD_LABEL;
}

/** 採点せずに全文認識を打ち切る(ダイアログを閉じたときなど) */
function abortFtRecognition() {
  if (!ftRecognition) return;
  ftRecActive = false;
  ftRecCancelled = true;
  try {
    ftRecognition.abort();
  } catch {}
}

function startFulltextPronCheck() {
  if (!SpeechRecognitionCtor) {
    showToast("このブラウザは音声認識に対応していません(ChromeやSafariでお試しください)。", 7000);
    return;
  }
  if (ftRecActive) {
    // 2回目のタップ = 読み終わり。認識を締めて採点へ
    ftRecActive = false;
    try {
      ftRecognition.stop();
    } catch {}
    return;
  }

  stopPlayAll(); // マイクがお手本を拾わないよう再生を止める
  stopRecognition();
  ftTranscript = "";
  ftRecActive = true;
  ftRecCancelled = false;

  ftRecordBtn.classList.add("record-btn-active");
  ftRecordBtn.textContent = "⏹ 全文を読み終えたらタップ";
  ftPronResult.innerHTML = `<p class="pron-heard">🎙 聞き取り中… 全文を最初から読み上げてください。</p>`;
  ftPronResult.classList.remove("hidden");

  const rec = new SpeechRecognitionCtor();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) {
        ftTranscript += r[0].transcript + " ";
      } else {
        interim += r[0].transcript;
      }
    }
    const heard = (ftTranscript + interim).trim();
    ftPronResult.innerHTML = `<p class="pron-heard">🎙 聞き取り中: …${escapeHtml(heard.slice(-100))}</p>`;
  };
  rec.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      showToast("マイクの使用が許可されていません。ブラウザの設定を確認してください。", 7000);
      ftRecActive = false;
      ftRecCancelled = true;
    }
    // no-speech などは onend 側で自動再開する
  };
  rec.onend = () => {
    if (ftRecActive) {
      // 無音などでモバイルが勝手に止めた場合は続きから再開する
      try {
        rec.start();
        return;
      } catch {
        ftRecActive = false;
      }
    }
    ftRecognition = null;
    resetFtRecordUi();
    if (!ftRecCancelled) {
      showPronResult(fulltextTarget(), ftTranscript.trim(), ftPronResult);
    } else {
      ftPronResult.classList.add("hidden");
    }
    ftRecCancelled = false;
  };

  ftRecognition = rec;
  try {
    rec.start();
  } catch {
    ftRecActive = false;
    ftRecognition = null;
    resetFtRecordUi();
  }
}

ftRecordBtn.addEventListener("click", startFulltextPronCheck);

ftRevealBtn.addEventListener("click", () => {
  ftEn.classList.remove("hidden");
  ftJa.classList.remove("hidden");
  ftRevealBtn.classList.add("hidden");
});

document.getElementById("ft-play").addEventListener("click", () => {
  abortFtRecognition();
  playAllCards();
});
document.getElementById("ft-slow").addEventListener("click", () => {
  abortFtRecognition();
  playAllCards(true);
});
document.getElementById("ft-stop").addEventListener("click", stopPlayAll);
document.getElementById("fulltext-close").addEventListener("click", () => fulltextDialog.close());
fulltextDialog.addEventListener("close", () => {
  stopPlayAll();
  abortFtRecognition();
});

// ---------------------------------------------------------------------------
// スプレッドシート同期 (Google Apps Script 経由。設定手順は docs/sheets-sync-setup.md)
// ---------------------------------------------------------------------------

const SYNC_STORAGE_KEY = "english.sync.v1";

const syncDialog = document.getElementById("sync-dialog");
const syncStatus = document.getElementById("sync-status");
const syncConfigDetails = document.getElementById("sync-config");
const saveBtn = document.getElementById("save-btn");
const syncPullBtn = document.getElementById("sync-pull");

function loadSyncConfig() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSyncConfig(config) {
  localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(config));
}

function isSyncConfigured() {
  const config = loadSyncConfig();
  return Boolean(config.url && config.key);
}

function openSyncDialog() {
  const config = loadSyncConfig();
  document.getElementById("sync-url").value = config.url || "";
  document.getElementById("sync-key").value = config.key || "";
  updateSyncUi();
  syncDialog.showModal();
}

function updateSyncUi() {
  const configured = isSyncConfigured();
  syncPullBtn.disabled = !configured;
  syncConfigDetails.open = !configured;
  if (!configured) {
    setSyncStatus("最初に下の「接続設定」からURLと合言葉を設定してください。");
  } else {
    const { lastSyncAt } = loadSyncConfig();
    setSyncStatus(
      lastSyncAt
        ? `前回の保存・読み込み: ${new Date(lastSyncAt).toLocaleString("ja-JP")}`
        : "設定済みです。「💾 保存」を押すとスプレッドシートに保存されます。"
    );
  }
}

function setSyncStatus(text) {
  syncStatus.textContent = text;
}

async function callSheetApi(payload) {
  const { url, key } = loadSyncConfig();
  // Content-Type を text/plain にすると CORS のプリフライトが発生せず、
  // Apps Script のウェブアプリにそのまま届く
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ key, ...payload }),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(
      "スプレッドシートからの応答を読み取れませんでした。URLとデプロイ設定(アクセス: 全員)を確認してください。"
    );
  }
  if (!data.ok) throw new Error(data.error || "不明なエラー");
  return data;
}

function markSynced() {
  const config = loadSyncConfig();
  config.lastSyncAt = new Date().toISOString();
  saveSyncConfig(config);
}

/** シートへ送る形式に変換(音声クリップの割り当てはJSON文字列で1列に収める) */
function cardsForSheet() {
  return cards.map((c) => ({
    ...c,
    audio: c.audio ? JSON.stringify(c.audio) : "",
  }));
}

/** シートから受け取ったカードをアプリの形式に戻す */
function migrateIncomingCard(c) {
  let audio = null;
  if (c.audio) {
    try {
      audio = typeof c.audio === "string" ? JSON.parse(c.audio) : c.audio;
    } catch {
      audio = null;
    }
  }
  return {
    id: String(c.id),
    en: String(c.en || ""),
    ja: String(c.ja || ""),
    level: Math.min(MAX_LEVEL, Number(c.level) || 0),
    dueAt: String(c.dueAt || toLocalDateStr()).slice(0, 10),
    reviews: Number(c.reviews) || 0,
    lapses: Number(c.lapses) || 0,
    addedAt: String(c.addedAt || new Date().toISOString()),
    lastReviewedAt: String(c.lastReviewedAt || ""),
    audio: audio && audio.trackId ? audio : null,
  };
}

async function pushToSheet() {
  if (!isSyncConfigured()) {
    openSyncDialog();
    return;
  }
  saveBtn.disabled = true;
  showToast("💾 スプレッドシートに保存しています…");
  try {
    const data = await callSheetApi({ action: "save", cards: cardsForSheet() });
    markSynced();
    clearDirty();
    showToast(`✅ ${data.count}枚をスプレッドシートに保存しました。`);
  } catch (err) {
    showToast(`保存に失敗しました: ${err.message}`, 8000);
  } finally {
    saveBtn.disabled = false;
  }
}

/** ページを開いたときにスプレッドシートの最新データを取り込む */
async function autoLoadFromSheet() {
  if (!isSyncConfigured()) return;
  if (isDirty()) {
    showToast(
      "⚠️ この端末に未保存の変更があるため、自動読み込みをスキップしました。「💾 保存」を押してください。",
      8000
    );
    return;
  }
  try {
    const data = await callSheetApi({ action: "load" });
    const incoming = (Array.isArray(data.cards) ? data.cards : []).map(migrateIncomingCard);
    cards = incoming;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
    clearDirty();
    render();
    markSynced();
    showToast(`☁️ 最新データを読み込みました(${incoming.length}枚)`);
  } catch (err) {
    showToast(`自動読み込みに失敗しました: ${err.message}`, 8000);
  }
}

async function pullFromSheet() {
  syncPullBtn.disabled = true;
  setSyncStatus("スプレッドシートから読み込んでいます…");
  try {
    const data = await callSheetApi({ action: "load" });
    const incoming = (Array.isArray(data.cards) ? data.cards : []).map(migrateIncomingCard);
    const message =
      `スプレッドシートの${incoming.length}枚で、` +
      `この端末の${cards.length}枚を置き換えます。よろしいですか?`;
    if (!confirm(message)) {
      setSyncStatus("読み込みをキャンセルしました。");
      return;
    }
    cards = incoming;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
    clearDirty();
    render();
    markSynced();
    setSyncStatus(`✅ ${incoming.length}枚を読み込みました。`);
  } catch (err) {
    setSyncStatus(`読み込みに失敗しました: ${err.message}`);
  } finally {
    syncPullBtn.disabled = false;
  }
}

saveBtn.addEventListener("click", pushToSheet);
document.getElementById("sync-settings-btn").addEventListener("click", openSyncDialog);
document.getElementById("sync-close").addEventListener("click", () => syncDialog.close());
syncPullBtn.addEventListener("click", pullFromSheet);

document.getElementById("sync-config-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const url = document.getElementById("sync-url").value.trim();
  const key = document.getElementById("sync-key").value.trim();
  if (!url || !key) {
    setSyncStatus("URLと合言葉の両方を入力してください。");
    return;
  }
  const config = loadSyncConfig();
  saveSyncConfig({ ...config, url, key });
  syncConfigDetails.open = false;
  updateSyncUi();
  setSyncStatus("設定を保存しました。まず「💾 保存」を押してスプレッドシートに書き込んでみてください。");
});

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

render();
autoLoadFromSheet();

/**
 * 英文暗記トレーニング — Googleスプレッドシート同期用 Apps Script
 *
 * 設置手順は docs/sheets-sync-setup.md を参照してください。
 * このスクリプトをスプレッドシートの「拡張機能 → Apps Script」に貼り付けて、
 * ウェブアプリとしてデプロイすると、アプリから英文カードのデータを
 * 保存・読み込みできるようになります。
 */

// ★ 必ず自分だけの合言葉に変更してください(アプリの接続設定に入力するものと同じ)
const SECRET_KEY = "ここを自分の合言葉に変える";

const SHEET_NAME = "cards";
const HEADERS = [
  "id",
  "en",
  "ja",
  "level",
  "dueAt",
  "reviews",
  "lapses",
  "addedAt",
  "lastReviewedAt",
  "audio", // 音声クリップの割り当て(JSON文字列)。音声ファイル自体は同期されません
];

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: "リクエストの形式が不正です" });
  }
  if (!req || req.key !== SECRET_KEY) {
    return json({ ok: false, error: "合言葉が一致しません" });
  }
  if (req.action === "save") return saveCards(req.cards || []);
  if (req.action === "load") return loadCards();
  return json({ ok: false, error: "不明な操作です" });
}

/** アプリから送られたカード一覧でcardsシートを丸ごと書き換える */
function saveCards(cards) {
  const sheet = getSheet();
  sheet.clearContents();
  const rows = [HEADERS].concat(
    cards.map(function (c) {
      return HEADERS.map(function (h) {
        return c[h] == null ? "" : c[h];
      });
    })
  );
  sheet.getRange(1, 1, rows.length, HEADERS.length).setValues(rows);
  return json({
    ok: true,
    count: cards.length,
    savedAt: new Date().toISOString(),
  });
}

/** cardsシートの内容をカード一覧として返す */
function loadCards() {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return json({ ok: true, cards: [] });

  const headers = values[0].map(String);
  const cards = values
    .slice(1)
    .filter(function (row) {
      return String(row[0]) !== "";
    })
    .map(function (row) {
      const c = {};
      headers.forEach(function (h, i) {
        c[h] = row[i];
      });
      c.id = String(c.id);
      c.en = String(c.en || "");
      c.ja = String(c.ja || "");
      c.audio = String(c.audio || "");
      c.level = Number(c.level) || 0;
      c.reviews = Number(c.reviews) || 0;
      c.lapses = Number(c.lapses) || 0;
      c.dueAt = toDateStr(c.dueAt);
      c.addedAt = toIso(c.addedAt);
      c.lastReviewedAt = toIsoOrEmpty(c.lastReviewedAt);
      return c;
    });
  return json({ ok: true, cards: cards });
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

/** スプレッドシートが日付として解釈した値もISO文字列に戻す */
function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  const s = String(value || "");
  return s || new Date().toISOString();
}

/** 日付をISO文字列に。空欄は空のまま */
function toIsoOrEmpty(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || "");
}

/** YYYY-MM-DD 形式の文字列に戻す(空欄は空のまま) */
function toDateStr(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd"
    );
  }
  return String(value || "").slice(0, 10);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

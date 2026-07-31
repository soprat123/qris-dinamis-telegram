import QRCode from "qrcode";
import jsQR from "jsqr";
import "./style.css";

const imageInput = document.querySelector("#qr-image");
const qrisInput = document.querySelector("#qris-input");
const amountInput = document.querySelector("#amount");
const generateButton = document.querySelector("#generate");
const status = document.querySelector("#status");
const result = document.querySelector("#result");
const canvas = document.querySelector("#qr-output");
const amountLabel = document.querySelector("#amount-label");
const download = document.querySelector("#download");

function parseTLV(payload) {
  const items = [];
  let offset = 0;

  while (offset < payload.length) {
    if (offset + 4 > payload.length) throw new Error("Struktur QRIS tidak lengkap.");
    const tag = payload.slice(offset, offset + 2);
    const lengthText = payload.slice(offset + 2, offset + 4);
    if (!/^\\d{2}$/.test(tag) || !/^\\d{2}$/.test(lengthText)) {
      throw new Error("Struktur tag QRIS tidak valid.");
    }

    const length = Number(lengthText);
    const valueStart = offset + 4;
    const valueEnd = valueStart + length;
    if (valueEnd > payload.length) throw new Error(`Nilai tag ${tag} tidak lengkap.`);

    items.push({ tag, value: payload.slice(valueStart, valueEnd) });
    offset = valueEnd;
  }

  return items;
}

function encodeTLV(tag, value) {
  const text = String(value);
  if (text.length > 99) throw new Error(`Nilai tag ${tag} terlalu panjang.`);
  return tag + String(text.length).padStart(2, "0") + text;
}

function crc16(text) {
  let crc = 0xffff;
  for (let index = 0; index < text.length; index += 1) {
    crc ^= text.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function normalizePayload(value) {
  return value.replace(/\\s+/g, "").trim();
}

function validateQRIS(payload) {
  const normalized = normalizePayload(payload);
  const items = parseTLV(normalized);
  const crcItem = items.at(-1);

  if (!items.some((item) => item.tag === "00" && item.value === "01")) {
    throw new Error("Payload bukan QRIS/EMVCo yang didukung.");
  }
  if (!crcItem || crcItem.tag !== "63" || crcItem.value.length !== 4) {
    throw new Error("Checksum QRIS tidak ditemukan.");
  }

  const withoutChecksum = normalized.slice(0, -4);
  const expected = crc16(withoutChecksum);
  if (expected !== crcItem.value.toUpperCase()) {
    throw new Error("Checksum QRIS tidak cocok. Gunakan QRIS asli yang valid.");
  }

  return items;
}

function convertToDynamic(payload, amount) {
  const items = validateQRIS(payload)
    .filter((item) => !["54", "63"].includes(item.tag))
    .map((item) => item.tag === "01" ? { ...item, value: "12" } : item);

  if (!items.some((item) => item.tag === "01")) {
    items.splice(1, 0, { tag: "01", value: "12" });
  }

  const amountItem = { tag: "54", value: String(amount) };
  const insertAt = items.findIndex((item) => Number(item.tag) > 54);
  items.splice(insertAt === -1 ? items.length : insertAt, 0, amountItem);

  const body = items.map(({ tag, value }) => encodeTLV(tag, value)).join("") + "6304";
  return body + crc16(body);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("File gambar tidak dapat dibaca."));
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("File gambar tidak dapat dibuka."));
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function scanWithJsQR(image, maximumSize) {
  const ratio = Math.min(1, maximumSize / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * ratio));
  const height = Math.max(1, Math.round(image.naturalHeight * ratio));
  const temp = document.createElement("canvas");
  temp.width = width;
  temp.height = height;

  const context = temp.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);

  const pixels = context.getImageData(0, 0, width, height);
  return jsQR(pixels.data, width, height, { inversionAttempts: "attemptBoth" })?.data;
}

async function decodeImage(file) {
  const image = await loadImage(file);

  if ("BarcodeDetector" in window) {
    try {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const [result] = await detector.detect(image);
      if (result?.rawValue) return result.rawValue;
    } catch {
      // Lanjutkan ke pemindai jsQR jika BarcodeDetector tidak didukung penuh.
    }
  }

  // Repo sumber memindai canvas pada ukuran asli. Batasi hanya untuk gambar
  // yang sangat besar agar browser Android tidak kehabisan memori.
  const largestSide = Math.max(image.naturalWidth, image.naturalHeight);
  const sizes = largestSide <= 4096
    ? [Number.POSITIVE_INFINITY, 2400, 1800, 1200, 800]
    : [3200, 2400, 1800, 1200, 800];

  for (const size of sizes) {
    const payload = scanWithJsQR(image, size);
    if (payload) return payload;
  }

  throw new Error("QR tidak terbaca. Gunakan screenshot QRIS asli yang jelas dan tidak terpotong.");
}

imageInput.addEventListener("change", async () => {
  const [file] = imageInput.files;
  if (!file) return;

  status.className = "status";
  status.textContent = "Membaca gambar QRIS…";
  result.hidden = true;

  try {
    const payload = await decodeImage(file);
    validateQRIS(payload);
    qrisInput.value = payload;
    status.className = "status success";
    status.textContent = "QRIS berhasil dibaca.";
  } catch (error) {
    status.className = "status error";
    status.textContent = error.message;
  }
});

generateButton.addEventListener("click", async () => {
  status.className = "status";
  result.hidden = true;

  try {
    const payload = normalizePayload(qrisInput.value);
    const amount = Number(amountInput.value);

    if (!payload) throw new Error("Unggah gambar atau masukkan payload QRIS.");
    if (!Number.isInteger(amount) || amount < 1 || amount > 10_000_000) {
      throw new Error("Nominal harus Rp1 sampai Rp10.000.000 tanpa desimal.");
    }

    const dynamicPayload = convertToDynamic(payload, amount);
    await QRCode.toCanvas(canvas, dynamicPayload, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#052e2b", light: "#ffffff" },
    });

    amountLabel.textContent = new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(amount);

    download.href = canvas.toDataURL("image/png");
    result.hidden = false;
    status.className = "status success";
    status.textContent = "QRIS dinamis berhasil dibuat.";
    result.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    status.className = "status error";
    status.textContent = error.message;
  }
});

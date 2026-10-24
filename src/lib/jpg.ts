import QRCode from "qrcode";
import { translate, type Language } from "./i18n";
export async function ticketJpg(
  event: { name: string; starts_at: string; venue: string },
  ticket: { id: string; name: string; category: string },
  qr: string,
  lang: Language,
) {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 2100;
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#f5f2e9";
  c.fillRect(0, 0, 1000, 2100);
  c.fillStyle = "#123f37";
  c.fillRect(0, 0, 1000, 180);
  c.fillStyle = "#fff";
  c.font = "bold 48px sans-serif";
  c.fillText("EVENT GATE", 65, 106);
  const text = (
    s: string,
    y: number,
    size = 36,
    color = "#123f37",
    width = 870,
  ) => {
    c.fillStyle = color;
    c.font = `${size}px sans-serif`;
    let line = "";
    for (const char of s) {
      if (c.measureText(line + char).width > width) {
        c.fillText(line, 65, y);
        y += size * 1.4;
        line = "";
      }
      line += char;
    }
    c.fillText(line, 65, y);
    return y + size * 1.5;
  };
  let y = text(event.name, 255, 42);
  y = text(new Date(event.starts_at).toLocaleString(lang), y + 10, 26);
  y = text(event.venue, y, 28);
  y = text(ticket.name, y + 25, 40);
  y = text(translate(lang, ticket.category), y + 5, 28);
  const qrY = Math.max(600, y + 35);
  const code = await QRCode.toDataURL(qr, {
    width: 580,
    margin: 4,
    errorCorrectionLevel: "M",
  });
  const image = new Image();
  image.src = code;
  await image.decode();
  c.drawImage(image, 210, qrY, 580, 580);
  text(ticket.id.slice(0, 8).toUpperCase(), qrY + 620, 26, "#52645f");
  const bottom = text(translate(lang, "private"), qrY + 675, 23, "#52645f");
  const cropped = document.createElement("canvas");
  cropped.width = 1000;
  cropped.height = bottom + 40;
  cropped.getContext("2d")!.drawImage(canvas, 0, 0);
  return cropped.toDataURL("image/jpeg", 0.92);
}
